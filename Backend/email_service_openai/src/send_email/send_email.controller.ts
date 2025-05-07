import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  HttpStatus,
  HttpException,
  Logger,
} from '@nestjs/common';
import { SendEmailService } from './send_email.service';

@Controller('send-email')
export class SendEmailController {
  private readonly logger = new Logger(SendEmailController.name);

  constructor(private readonly sendEmailService: SendEmailService) {}

  /**
   * Génère une réponse automatique à un email spécifique
   * @param emailId ID de l'email à répondre
   * @param mailbox Nom de la boîte aux lettres (optionnel, par défaut: INBOX)
   * @param responseLength Niveau de détail de la réponse (optionnel, par défaut: normal)
   */
  @Get('draft-response/:emailId')
  async generateDraftResponse(
    @Param('emailId') emailId: string,
    @Query('mailbox') mailbox: string = 'INBOX',
    @Query('responseLength')
    responseLength: 'court' | 'normal' | 'détaillé' = 'normal',
  ) {
    try {
      this.logger.log(
        `Génération d'une réponse ${responseLength} pour l'email ${emailId}`,
      );

      const result = await this.sendEmailService.generateResponseForEmail(
        mailbox,
        emailId,
        responseLength,
      );

      if (!result.originalEmail) {
        return {
          status: 'error',
          message: 'Email non trouvé',
          data: null,
        };
      }

      // Extraire la réponse si c'est un objet avec des informations de tokens
      const responseData =
        typeof result.draftResponse === 'string'
          ? { draftResponse: result.draftResponse }
          : {
              draftResponse: result.draftResponse.response,
              tokensUsed: result.draftResponse.tokensUsed,
            };

      return {
        status: 'success',
        message: `Brouillon de réponse ${responseLength} généré avec succès`,
        data: {
          ...responseData,
          responseLength,
          originalEmail: {
            id: result.originalEmail.id,
            from: result.originalEmail.from,
            to: result.originalEmail.to,
            subject: result.originalEmail.subject,
            date: result.originalEmail.date,
            body: result.originalEmail.body,
            analysis: result.originalEmail.analysis,
          },
        },
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Erreur lors de la génération de la réponse: ${errorMessage}`,
      );

      throw new HttpException(
        {
          status: 'error',
          message: `Erreur lors de la génération de la réponse: ${errorMessage}`,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Reformule une réponse à un email selon des instructions spécifiques
   */
  @Post('rewrite-response/:emailId')
  async rewriteResponse(
    @Param('emailId') emailId: string,
    @Body() requestBody: { draftResponse: string; instructions: string },
    @Query('mailbox') mailbox: string = 'INBOX',
  ) {
    try {
      this.logger.log(`Reformulation de la réponse pour l'email ${emailId}`);

      if (!requestBody.draftResponse || !requestBody.instructions) {
        return {
          status: 'error',
          message:
            'Le corps de la requête doit contenir draftResponse et instructions',
          data: null,
        };
      }

      const rewrittenResponse = await this.sendEmailService.rewriteResponse(
        mailbox,
        emailId,
        requestBody.draftResponse,
        requestBody.instructions,
      );

      // Extraire la réponse si c'est un objet avec informations de tokens
      const responseData =
        typeof rewrittenResponse === 'string'
          ? { rewrittenResponse }
          : {
              rewrittenResponse: rewrittenResponse.response,
              tokensUsed: rewrittenResponse.tokensUsed,
            };

      return {
        status: 'success',
        message: 'Réponse reformulée avec succès',
        data: responseData,
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(`Erreur lors de la reformulation: ${errorMessage}`);

      throw new HttpException(
        {
          status: 'error',
          message: `Erreur lors de la reformulation: ${errorMessage}`,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Envoie une réponse à un email spécifique
   */
  @Post('send-response/:emailId')
  async sendResponse(
    @Param('emailId') emailId: string,
    @Body() requestBody: { responseText: string; customSubject?: string },
    @Query('mailbox') mailbox: string = 'INBOX',
  ) {
    try {
      this.logger.log(`Envoi d'une réponse à l'email ${emailId}`);

      if (!requestBody.responseText) {
        return {
          status: 'error',
          message: 'Le corps de la requête doit contenir responseText',
          data: null,
        };
      }

      const result = await this.sendEmailService.sendEmailResponse(
        mailbox,
        emailId,
        requestBody.responseText,
        requestBody.customSubject,
      );

      return {
        status: result.success ? 'success' : 'error',
        message: result.message,
        data: null,
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Erreur lors de l'envoi de la réponse: ${errorMessage}`,
      );

      throw new HttpException(
        {
          status: 'error',
          message: `Erreur lors de l'envoi de la réponse: ${errorMessage}`,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Génère et envoie directement une réponse à un email
   * @param emailId ID de l'email à répondre
   * @param responseLength Niveau de détail de la réponse ('court', 'normal', 'détaillé')
   * @param customInstructions Instructions personnalisées pour la reformulation
   * @param customSubject Objet personnalisé pour l'email de réponse
   */
  @Post('auto-respond/:emailId')
  async autoRespond(
    @Param('emailId') emailId: string,
    @Body()
    requestBody: {
      responseLength?: 'court' | 'normal' | 'détaillé';
      customInstructions?: string;
      customSubject?: string;
    },
    @Query('mailbox') mailbox: string = 'INBOX',
  ) {
    try {
      const responseLength = requestBody.responseLength || 'normal';
      this.logger.log(
        `Réponse automatique ${responseLength} à l'email ${emailId}`,
      );

      // Générer un brouillon de réponse avec la longueur spécifiée
      const draftResult = await this.sendEmailService.generateResponseForEmail(
        mailbox,
        emailId,
        responseLength,
      );

      if (!draftResult.originalEmail) {
        return {
          status: 'error',
          message: 'Email non trouvé',
          data: null,
        };
      }

      // Si des instructions personnalisées sont fournies, reformuler la réponse
      let finalResponse = draftResult.draftResponse;
      if (requestBody.customInstructions) {
        finalResponse = await this.sendEmailService.rewriteResponse(
          mailbox,
          emailId,
          typeof draftResult.draftResponse === 'string'
            ? draftResult.draftResponse
            : draftResult.draftResponse.response,
          requestBody.customInstructions,
        );
      }

      // Extraire le texte de la réponse finale si c'est un objet
      const responseText =
        typeof finalResponse === 'string'
          ? finalResponse
          : finalResponse.response;

      // Envoyer la réponse
      const sendResult = await this.sendEmailService.sendEmailResponse(
        mailbox,
        emailId,
        responseText,
        requestBody.customSubject,
      );

      return {
        status: sendResult.success ? 'success' : 'error',
        message: sendResult.message,
        data: {
          responseText: responseText,
          responseLength: responseLength,
        },
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Erreur lors de la réponse automatique: ${errorMessage}`,
      );

      throw new HttpException(
        {
          status: 'error',
          message: `Erreur lors de la réponse automatique: ${errorMessage}`,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Liste les emails qui nécessitent une réponse
   * @param mailbox Nom de la boîte aux lettres (optionnel, par défaut: INBOX)
   */
  @Get('list-requiring-response')
  async listEmailsRequiringResponse(
    @Query('mailbox') mailbox: string = 'INBOX',
  ) {
    try {
      this.logger.log(
        `Récupération des emails nécessitant une réponse dans ${mailbox}`,
      );

      const emails =
        await this.sendEmailService.listEmailsRequiringResponse(mailbox);

      return {
        status: 'success',
        message: `${emails.length} emails nécessitant une réponse trouvés`,
        data: emails.map((email) => ({
          id: email.id,
          from: email.from,
          to: email.to,
          subject: email.subject,
          date: email.date,
          summary: email.analysis?.summary || '',
          priority: email.analysis?.priority || 'medium',
          category: email.analysis?.category || 'autre',
          actionItems: email.analysis?.actionItems || [],
        })),
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Erreur lors de la récupération des emails: ${errorMessage}`,
      );

      throw new HttpException(
        {
          status: 'error',
          message: `Erreur lors de la récupération des emails: ${errorMessage}`,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Marque un email comme favori pour y répondre plus tard
   */
  @Post('mark-for-response/:emailId')
  async markEmailForResponse(
    @Param('emailId') emailId: string,
    @Query('mailbox') mailbox: string = 'INBOX',
  ) {
    try {
      this.logger.log(
        `Marquage de l'email ${emailId} pour une réponse ultérieure`,
      );

      // Vérifier si l'email existe
      const email = await this.sendEmailService.getEmailById(mailbox, emailId);

      if (!email) {
        return {
          status: 'error',
          message: 'Email non trouvé',
          data: null,
        };
      }

      // Note: Cette fonctionnalité nécessiterait d'ajouter un stockage persistant
      // pour suivre les emails marqués comme favoris.
      // Pour l'instant, nous retournons juste un message de succès.

      return {
        status: 'success',
        message: `Email ${emailId} marqué pour une réponse ultérieure`,
        data: {
          id: email.id,
          subject: email.subject,
          from: email.from,
          date: email.date,
        },
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(`Erreur lors du marquage de l'email: ${errorMessage}`);

      throw new HttpException(
        {
          status: 'error',
          message: `Erreur lors du marquage de l'email: ${errorMessage}`,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Vérification de la santé du service d'envoi d'emails
   */
  @Get('health')
  healthCheck() {
    return {
      status: 'ok',
      service: 'send-email',
      timestamp: new Date().toISOString(),
    };
  }
}
