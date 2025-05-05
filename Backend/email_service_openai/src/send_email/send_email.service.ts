import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import {
  AnalyzeEmailService,
  EmailContent,
} from '../analyze_email/analyze_email.service';

@Injectable()
export class SendEmailService {
  private readonly logger = new Logger(SendEmailService.name);
  private transporter: nodemailer.Transporter;

  constructor(
    private configService: ConfigService,
    private analyzeEmailService: AnalyzeEmailService,
  ) {
    // Configuration du transporteur SMTP
    this.transporter = nodemailer.createTransport({
      host: this.configService.get<string>('SMTP_HOST'),
      port: parseInt(this.configService.get<string>('SMTP_PORT') || '587', 10),
      secure: this.configService.get<string>('SMTP_SECURE') === 'true',
      auth: {
        user: this.configService.get<string>('EMAIL_USER'),
        pass: this.configService.get<string>('EMAIL_PASSWORD'),
      },
    });

    this.logger.log("Service d'envoi d'emails initialisé");
  }

  /**
   * Récupère un email spécifique par son ID
   * @param mailbox Boîte mail à analyser
   * @param emailId ID de l'email à récupérer
   */
  async getEmailById(
    mailbox: string,
    emailId: string,
  ): Promise<EmailContent | null> {
    try {
      // Récupérer tous les emails du jour
      const emails = await this.analyzeEmailService.getAllTodayEmails();

      // Trouver l'email avec l'ID spécifié
      const email = emails.find((e) => e.id === emailId);

      if (!email) {
        this.logger.warn(`Email avec ID ${emailId} non trouvé dans ${mailbox}`);
        return null;
      }

      return email;
    } catch (error: any) {
      this.logger.error(
        `Erreur lors de la récupération de l'email: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Génère une réponse automatique à un email
   * @param mailbox Boîte mail contenant l'email
   * @param emailId ID de l'email à répondre
   */
  async generateResponseForEmail(
    mailbox: string,
    emailId: string,
  ): Promise<{
    originalEmail: EmailContent | null;
    draftResponse: string 
      | { response: string; tokensUsed: { input: number; output: number; total: number; }; };
  }> {
    try {
      // Récupérer l'email original
      const email = await this.getEmailById(mailbox, emailId);

      if (!email) {
        return {
          originalEmail: null,
          draftResponse: 'Email non trouvé',
        };
      }

      // Analyser l'email s'il n'a pas encore été analysé
      const analyzedEmail = email.analysis
        ? email
        : (await this.analyzeEmailService.analyzeEmails([email]))[0];

      // Générer une réponse automatique
      const draftResponse =
        await this.analyzeEmailService.generateEmailResponse(analyzedEmail);

      return {
        originalEmail: analyzedEmail,
        draftResponse,
      };
    } catch (error: any) {
      this.logger.error(
        `Erreur lors de la génération de la réponse: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Reformule une réponse à un email selon des instructions spécifiques
   * @param mailbox Boîte mail contenant l'email
   * @param emailId ID de l'email à répondre
   * @param draftResponse Brouillon de réponse à reformuler
   * @param instructions Instructions pour la reformulation
   */
  async rewriteResponse(
    mailbox: string,
    emailId: string,
    draftResponse: string,
    instructions: string,
  ): Promise<
    string 
    | { response: string; tokensUsed: { input: number; output: number; total: number; }; }
  > {
    try {
      // Récupérer l'email original
      const email = await this.getEmailById(mailbox, emailId);

      if (!email) {
        return 'Email non trouvé. Impossible de reformuler la réponse.';
      }

      // Reformuler la réponse
      const rewrittenResponse =
        await this.analyzeEmailService.rewriteEmailResponse(
          email,
          draftResponse,
          instructions,
        );

      return rewrittenResponse;
    } catch (error: any) {
      this.logger.error(
        `Erreur lors de la reformulation de la réponse: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Envoie une réponse à un email
   * @param mailbox Boîte mail contenant l'email original
   * @param emailId ID de l'email auquel répondre
   * @param responseText Texte de la réponse à envoyer
   * @param customSubject Objet personnalisé (si vide, utilisera Re: + objet original)
   */
  async sendEmailResponse(
    mailbox: string,
    emailId: string,
    responseText: string,
    customSubject?: string,
  ): Promise<{
    success: boolean;
    message: string;
  }> {
    try {
      // Récupérer l'email original
      const originalEmail = await this.getEmailById(mailbox, emailId);

      if (!originalEmail) {
        return {
          success: false,
          message:
            "Email original non trouvé. Impossible d'envoyer la réponse.",
        };
      }

      // Préparer les détails de l'email
      const from = this.configService.get<string>('EMAIL_USER') || '';
      const to = originalEmail.from.replace(/.*<(.*)>.*/, '$1'); // Extraire l'adresse email
      const subject = customSubject || `Re: ${originalEmail.subject}`;

      // Envoyer l'email
      const info = await this.transporter.sendMail({
        from,
        to,
        subject,
        text: responseText,
      });

      this.logger.log(`Réponse envoyée: ${info.messageId}`);

      return {
        success: true,
        message: `Réponse envoyée avec succès à ${to}`,
      };
    } catch (error: any) {
      this.logger.error(`Erreur lors de l'envoi de l'email: ${error.message}`);

      return {
        success: false,
        message: `Erreur lors de l'envoi: ${error.message}`,
      };
    }
  }

  /**
   * Liste les emails qui nécessitent une réponse
   * @param mailbox Boîte mail à analyser
   * @param daysBack Nombre de jours à considérer (pour inclure des emails plus anciens)
   */
  async listEmailsRequiringResponse(
    mailbox: string = 'INBOX',
    daysBack: number = 7,
  ): Promise<EmailContent[]> {
    try {
      // Récupérer tous les emails récents
      const allEmails = await this.analyzeEmailService.getAllTodayEmails();

      // Analyser les emails qui n'ont pas encore été analysés
      const emailsToAnalyze = allEmails.filter((email) => !email.analysis);
      if (emailsToAnalyze.length > 0) {
        await this.analyzeEmailService.analyzeEmails(emailsToAnalyze);
      }

      // Maintenant tous les emails ont une analyse
      const analyzedEmails = [...allEmails];

      // Filtrer les emails qui nécessitent une réponse
      const emailsRequiringResponse = analyzedEmails.filter((email) => {
        // Vérifier si l'email nécessite une action
        if (!email.analysis || !email.analysis.actionRequired) {
          return false;
        }

        // Vérifier si une des actions suggérées est de répondre à l'email
        return (
          email.analysis.actionItems?.some(
            (item) =>
              item.toLowerCase().includes('répondre') ||
              item.toLowerCase().includes('repondre'),
          ) || false
        );
      });

      return emailsRequiringResponse;
    } catch (error: any) {
      this.logger.error(
        `Erreur lors de la récupération des emails nécessitant une réponse: ${error.message}`,
      );
      throw error;
    }
  }
}
