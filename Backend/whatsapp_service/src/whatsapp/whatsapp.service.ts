import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

interface WhatsappMessage {
  id: string;
  from: string;
  timestamp: string;
  text: {
    body: string;
  };
}

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);
  private readonly emailServiceUrl: string;
  private readonly whatsappToken: string;
  private readonly phoneNumberId: string;

  constructor(private configService: ConfigService) {
    this.emailServiceUrl =
      this.configService.get<string>('EMAIL_SERVICE_URL') ||
      'http://email_service_openai:3002';
    this.whatsappToken = this.configService.get<string>('WHATSAPP_TOKEN') || '';
    this.phoneNumberId =
      this.configService.get<string>('PHONE_NUMBER_ID') || '';

    this.logger.log(
      `Service WhatsApp initialisé, URL du service email: ${this.emailServiceUrl}`,
    );
  }

  /**
   * Traite les messages entrants de WhatsApp
   */
  async handleIncomingMessage(message: WhatsappMessage): Promise<void> {
    try {
      this.logger.log(`Message reçu de ${message.from}: ${message.text.body}`);

      const messageText = message.text.body.toLowerCase();
      let response =
        'Commande non reconnue. Essayez "analyser factures", "analyser toutes factures", "résumé professionnel" ou "aide"';

      if (messageText.includes('aide')) {
        response =
          'Commandes disponibles:\n' +
          '- "analyser factures": Analyse les factures non lues\n' +
          '- "analyser toutes factures": Analyse toutes les factures\n' +
          '- "résumé professionnel": Aperçu structuré pour usage en entreprise\n' +
          '- "aide": Affiche ce message';
      } else if (
        messageText.includes('résumé') &&
        messageText.includes('pro')
      ) {
        // Si l'utilisateur demande un résumé professionnel
        const endpoint =
          messageText.includes('tous') ||
          messageText.includes('tous les emails')
            ? '/analyze-email/professional-summary/all' // Pour tous les emails (lus et non lus)
            : '/analyze-email/professional-summary'; // Pour les emails non lus seulement

        response = 'Génération du résumé professionnel en cours...';

        const apiResponse = await this.callEmailService(endpoint);

        if (apiResponse.success && apiResponse.professionalSummary) {
          // Utiliser directement le résumé professionnel formaté par le backend
          response = apiResponse.professionalSummary;
        } else {
          response = `❌ Erreur: Impossible de générer le résumé professionnel`;
        }
      } else if (
        messageText.includes('analyser') &&
        messageText.includes('facture')
      ) {
        let endpoint = '/sort-email/analyze-all-folders/unread';

        // Si "toutes" est mentionné, analyser tous les emails
        if (messageText.includes('toute')) {
          endpoint = '/sort-email/analyze-all-folders/all';
          response = 'Analyse de toutes les factures en cours...';
        } else {
          response = 'Analyse des factures non lues en cours...';
        }

        // Appeler l'API d'analyse des factures
        const apiResponse = await this.callEmailService(endpoint);

        if (apiResponse.success) {
          response = `✅ ${apiResponse.message}\n\n`;

          if (apiResponse.invoices && apiResponse.invoices.length > 0) {
            // Ajouter un résumé des factures
            response += `📊 Résumé des factures (${apiResponse.invoices.length}):\n\n`;

            for (const invoice of apiResponse.invoices.slice(0, 5)) {
              // Limiter à 5 factures pour éviter les messages trop longs
              response += this.formatInvoice(invoice) + '\n\n';
            }

            if (apiResponse.invoices.length > 5) {
              response += `...et ${apiResponse.invoices.length - 5} autres factures`;
            }
          } else {
            response += 'Aucune facture trouvée.';
          }
        } else {
          response = `❌ Erreur: ${apiResponse.message || 'Erreur inconnue'}`;
        }
      }

      // Envoyer la réponse à l'utilisateur
      await this.sendWhatsappMessage(message.from, response);
    } catch (error) {
      this.logger.error(
        `Erreur lors du traitement du message: ${error.message}`,
      );
      await this.sendWhatsappMessage(
        message.from,
        'Une erreur est survenue lors du traitement de votre demande.',
      );
    }
  }

  /**
   * Formate le résumé général pour une présentation professionnelle
   */
  private formatSummaryOverview(summary: any): string {
    try {
      // Structurer le résumé par catégories professionnelles
      let formattedOverview = `📋 *RÉSUMÉ PROFESSIONNEL*\n\n`;

      // Statistiques globales
      formattedOverview += `*Aperçu général:*\n`;
      formattedOverview += `• Total emails: ${summary.totalEmails}\n`;
      formattedOverview += `• Emails haute priorité: ${summary.highPriorityCount}\n`;
      formattedOverview += `• Actions requises: ${summary.actionRequiredCount}\n\n`;

      // Répartition par catégories professionnelles
      formattedOverview += `*Répartition par catégories:*\n`;
      if (summary.categoryCounts) {
        if (summary.categoryCounts.professionnel)
          formattedOverview += `• Professionnels: ${summary.categoryCounts.professionnel}\n`;

        if (summary.categoryCounts.facture)
          formattedOverview += `• Factures: ${summary.categoryCounts.facture}\n`;

        if (summary.categoryCounts.marketing)
          formattedOverview += `• Marketing: ${summary.categoryCounts.marketing}\n`;

        // Autres catégories si nécessaire
        Object.entries(summary.categoryCounts)
          .filter(
            ([key]) =>
              !['professionnel', 'facture', 'marketing', 'personnel'].includes(
                key,
              ),
          )
          .forEach(([key, count]) => {
            formattedOverview += `• ${key.charAt(0).toUpperCase() + key.slice(1)}: ${count}\n`;
          });
      }

      // Actions à entreprendre
      if (summary.actionItems && summary.actionItems.length > 0) {
        formattedOverview += `\n*Actions requises:*\n`;

        // Regrouper les tâches par catégorie professionnelle
        const professionalTasks = summary.actionItems.filter(
          (item) =>
            !item.toLowerCase().includes('facebook') &&
            !item.toLowerCase().includes('personnel'),
        );

        professionalTasks.forEach((item, index) => {
          formattedOverview += `${index + 1}. ${item}\n`;
        });
      }

      // Emails haute priorité professionnels
      if (summary.topPriorityEmails && summary.topPriorityEmails.length > 0) {
        const professionalHighPriority = summary.topPriorityEmails.filter(
          (email) =>
            email.analysis.category === 'professionnel' ||
            email.analysis.category === 'facture',
        );

        if (professionalHighPriority.length > 0) {
          formattedOverview += `\n*Emails professionnels prioritaires:*\n`;
          professionalHighPriority.forEach((email) => {
            formattedOverview += `• ${email.subject} - ${email.analysis.summary}\n`;
          });
        }
      }

      return formattedOverview;
    } catch (error) {
      this.logger.error(`Erreur lors du formatage du résumé: ${error.message}`);
      return 'Impossible de générer le résumé professionnel';
    }
  }

  /**
   * Formate une facture pour l'affichage dans WhatsApp
   */
  private formatInvoice(invoice: any): string {
    try {
      return (
        `📄 *Facture* - ${invoice.invoiceData.émetteur || 'N/A'}\n` +
        `• *Référence:* ${invoice.invoiceData.numéroFacture || 'N/A'}\n` +
        `• *Montant:* ${invoice.invoiceData.montantTotal || 'N/A'}\n` +
        `• *Date émission:* ${invoice.invoiceData.dateFacture || invoice.date || 'N/A'}\n` +
        `• *Échéance:* ${invoice.invoiceData.dateÉchéance || 'N/A'}`
      );
    } catch (error) {
      this.logger.error(
        `Erreur lors du formatage de la facture: ${error.message}`,
      );
      return 'Facture (détails non disponibles)';
    }
  }

  /**
   * Appelle l'API de service email
   */
  private async callEmailService(endpoint: string): Promise<any> {
    try {
      this.logger.log(`Appel de l'API: ${this.emailServiceUrl}${endpoint}`);

      const response = await axios.post(`${this.emailServiceUrl}${endpoint}`);
      return response.data;
    } catch (error) {
      this.logger.error(`Erreur lors de l'appel à l'API: ${error.message}`);
      return {
        success: false,
        message: `Erreur de communication avec le service email: ${error.message}`,
      };
    }
  }

  /**
   * Envoie un message WhatsApp à l'utilisateur
   */
  private async sendWhatsappMessage(to: string, body: string): Promise<void> {
    try {
      if (!this.whatsappToken || !this.phoneNumberId) {
        this.logger.warn(
          'Configuration WhatsApp incomplète, le message ne sera pas envoyé',
        );
        return;
      }

      this.logger.log(`Envoi d'un message WhatsApp à ${to}`);

      await axios.post(
        `https://graph.facebook.com/v18.0/${this.phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: to,
          type: 'text',
          text: { body: body },
        },
        {
          headers: {
            Authorization: `Bearer ${this.whatsappToken}`,
            'Content-Type': 'application/json',
          },
        },
      );

      this.logger.log('Message WhatsApp envoyé avec succès');
    } catch (error) {
      this.logger.error(
        `Erreur lors de l'envoi du message WhatsApp: ${error.message}`,
      );
    }
  }

  /**
   * Vérifie le token de webhook
   */
  verifyWebhook(mode: string, token: string): boolean {
    const verifyToken = this.configService.get<string>('WHATSAPP_VERIFY_TOKEN');
    return mode === 'subscribe' && token === verifyToken;
  }
}
