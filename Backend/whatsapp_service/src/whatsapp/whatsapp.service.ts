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
    this.emailServiceUrl = this.configService.get<string>('EMAIL_SERVICE_URL') || 'http://email_service_openai:3002';
    this.whatsappToken = this.configService.get<string>('WHATSAPP_TOKEN') || '';
    this.phoneNumberId = this.configService.get<string>('PHONE_NUMBER_ID') || '';
    
    this.logger.log(`Service WhatsApp initialisé, URL du service email: ${this.emailServiceUrl}`);
  }

  /**
   * Traite les messages entrants de WhatsApp
   */
  async handleIncomingMessage(message: WhatsappMessage): Promise<void> {
    try {
      this.logger.log(`Message reçu de ${message.from}: ${message.text.body}`);
      
      const messageText = message.text.body.toLowerCase();
      let response = 'Commande non reconnue. Essayez "analyser factures", "analyser toutes factures" ou "aide"';
      
      if (messageText.includes('aide')) {
        response = 'Commandes disponibles:\n' +
                  '- "analyser factures": Analyse les factures non lues\n' +
                  '- "analyser toutes factures": Analyse toutes les factures\n' +
                  '- "aide": Affiche ce message';
      } 
      else if (messageText.includes('analyser') && messageText.includes('facture')) {
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
            
            for (const invoice of apiResponse.invoices.slice(0, 5)) { // Limiter à 5 factures pour éviter les messages trop longs
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
      this.logger.error(`Erreur lors du traitement du message: ${error.message}`);
      await this.sendWhatsappMessage(message.from, 'Une erreur est survenue lors du traitement de votre demande.');
    }
  }
  
  /**
   * Formate une facture pour l'affichage dans WhatsApp
   */
  private formatInvoice(invoice: any): string {
    try {
      return `📄 *Facture de ${invoice.invoiceData.émetteur || 'N/A'}*\n` +
             `Montant: ${invoice.invoiceData.montantTotal || 'N/A'}\n` +
             `Date: ${invoice.invoiceData.dateFacture || invoice.date || 'N/A'}\n` +
             `Échéance: ${invoice.invoiceData.dateÉchéance || 'N/A'}\n` +
             `N° Facture: ${invoice.invoiceData.numéroFacture || 'N/A'}`;
    } catch (error) {
      this.logger.error(`Erreur lors du formatage de la facture: ${error.message}`);
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
        this.logger.warn('Configuration WhatsApp incomplète, le message ne sera pas envoyé');
        return;
      }
      
      this.logger.log(`Envoi d'un message WhatsApp à ${to}`);
      
      await axios.post(
        `https://graph.facebook.com/v18.0/${this.phoneNumberId}/messages`,
        {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: to,
          type: "text",
          text: { body: body }
        },
        {
          headers: {
            'Authorization': `Bearer ${this.whatsappToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      this.logger.log('Message WhatsApp envoyé avec succès');
      
    } catch (error) {
      this.logger.error(`Erreur lors de l'envoi du message WhatsApp: ${error.message}`);
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