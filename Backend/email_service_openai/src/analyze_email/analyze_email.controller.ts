import {
  Controller,
  Get,
  HttpStatus,
  HttpException,
  Logger,
  Query,
} from '@nestjs/common';
import { AnalyzeEmailService, EmailContent } from './analyze_email.service';

@Controller('analyze-email')
export class AnalyzeEmailController {
  private readonly logger = new Logger(AnalyzeEmailController.name);

  constructor(private readonly analyzeEmailService: AnalyzeEmailService) {}

  /**
   * Récupère et analyse les emails non lus d'aujourd'hui avec un résumé général
   * @param mailbox Nom de la boîte aux lettres à analyser (optionnel, par défaut: INBOX)
   * @param summary Si true, inclut un résumé général des emails (optionnel, par défaut: false)
   */
  @Get('today')
  async analyzeTodayEmails(
    @Query('mailbox') mailbox?: string,
    @Query('summary') summary?: string,
  ): Promise<{
    status: string;
    message: string;
    data: EmailContent[];
    summary?: {
      overview: string;
      totalEmails: number;
      highPriorityCount: number;
      actionRequiredCount: number;
      categoryCounts: Record<string, number>;
      topPriorityEmails: EmailContent[];
      actionItems: string[];
    };
  }> {
    try {
      this.logger.log(
        `Début de l'analyse des emails non lus d'aujourd'hui${mailbox ? ` dans ${mailbox}` : ''}`,
      );

      // Récupération des emails non lus du jour
      const todayEmails =
        await this.analyzeEmailService.getTodayEmails(mailbox);

      if (todayEmails.length === 0) {
        return {
          status: 'success',
          message: `Aucun email non lu trouvé pour aujourd'hui${mailbox ? ` dans ${mailbox}` : ''}`,
          data: [],
        };
      }

      // Analyse des emails récupérés
      const analyzedEmails =
        await this.analyzeEmailService.analyzeEmails(todayEmails);

      // Si résumé demandé, générer un résumé global
      if (summary === 'true') {
        const overallSummary =
          await this.analyzeEmailService.generateOverallSummary(analyzedEmails);

        return {
          status: 'success',
          message: `${analyzedEmails.length} emails non lus analysés avec succès`,
          data: analyzedEmails,
          summary: {
            overview: overallSummary.summary,
            totalEmails: overallSummary.totalEmails,
            highPriorityCount: overallSummary.highPriorityCount,
            actionRequiredCount: overallSummary.actionRequiredCount,
            categoryCounts: overallSummary.categoryCounts,
            topPriorityEmails: overallSummary.topPriorityEmails,
            actionItems: overallSummary.actionItems,
          },
        };
      }

      return {
        status: 'success',
        message: `${analyzedEmails.length} emails non lus analysés avec succès`,
        data: analyzedEmails,
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(`Erreur lors de l'analyse des emails: ${errorMessage}`);
      throw new HttpException(
        {
          status: 'error',
          message: `Erreur lors de l'analyse des emails: ${errorMessage}`,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Endpoint dédié au résumé global des emails d'aujourd'hui
   * @param mailbox Nom de la boîte aux lettres à analyser (optionnel, par défaut: INBOX)
   */
  @Get('today/summary')
  async getTodayEmailsSummary(@Query('mailbox') mailbox?: string): Promise<{
    status: string;
    message: string;
    summary: {
      overview: string;
      totalEmails: number;
      highPriorityCount: number;
      actionRequiredCount: number;
      categoryCounts: Record<string, number>;
      topPriorityEmails: EmailContent[];
      actionItems: string[];
    };
  }> {
    try {
      this.logger.log(
        `Génération du résumé des emails non lus d'aujourd'hui${mailbox ? ` dans ${mailbox}` : ''}`,
      );

      // Récupération et analyse des emails
      const todayEmails =
        await this.analyzeEmailService.getTodayEmails(mailbox);

      if (todayEmails.length === 0) {
        return {
          status: 'success',
          message: `Aucun email non lu trouvé pour aujourd'hui${mailbox ? ` dans ${mailbox}` : ''}`,
          summary: {
            overview: 'Aucun email à analyser',
            totalEmails: 0,
            highPriorityCount: 0,
            actionRequiredCount: 0,
            categoryCounts: {},
            topPriorityEmails: [],
            actionItems: [],
          },
        };
      }

      const analyzedEmails =
        await this.analyzeEmailService.analyzeEmails(todayEmails);
      const overallSummary =
        await this.analyzeEmailService.generateOverallSummary(analyzedEmails);

      return {
        status: 'success',
        message: `Résumé généré pour ${analyzedEmails.length} emails non lus`,
        summary: {
          overview: overallSummary.summary,
          totalEmails: overallSummary.totalEmails,
          highPriorityCount: overallSummary.highPriorityCount,
          actionRequiredCount: overallSummary.actionRequiredCount,
          categoryCounts: overallSummary.categoryCounts,
          topPriorityEmails: overallSummary.topPriorityEmails,
          actionItems: overallSummary.actionItems,
        },
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Erreur lors de la génération du résumé: ${errorMessage}`,
      );
      throw new HttpException(
        {
          status: 'error',
          message: `Erreur lors de la génération du résumé: ${errorMessage}`,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Vérification de la santé du service d'analyse
   */
  @Get('health')
  healthCheck() {
    return {
      status: 'ok',
      service: 'analyze-email',
      timestamp: new Date().toISOString(),
    };
  }
}
