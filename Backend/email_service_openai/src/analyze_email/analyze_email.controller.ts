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
   * @param summary Si true, inclut un résumé général des emails (optionnel, par défaut: false)
   */
  @Get('today')
  async analyzeTodayEmails(@Query('summary') summary?: string): Promise<{
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
      tokensUsed?: {
        input: number;
        output: number;
        total: number;
      };
    };
    tokensUsed?: {
      input: number;
      output: number;
      total: number;
    };
  }> {
    try {
      this.logger.log(
        `Début de l'analyse des emails non lus d'aujourd'hui dans tous les dossiers`,
      );

      // Récupération des emails non lus du jour
      const todayEmails = await this.analyzeEmailService.getTodayEmails();

      if (todayEmails.length === 0) {
        return {
          status: 'success',
          message: `Aucun email non lu trouvé pour aujourd'hui dans tous les dossiers`,
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

        // Calculer le total des tokens utilisés (analyse d'emails + résumé)
        const totalTokensUsed = {
          input: overallSummary.tokensUsed?.input || 0,
          output: overallSummary.tokensUsed?.output || 0,
          total: overallSummary.tokensUsed?.total || 0,
        };

        // Ajouter les tokens utilisés par l'analyse individuelle des emails
        analyzedEmails.forEach((email) => {
          if (email.analysis?.tokensUsed) {
            totalTokensUsed.input += email.analysis.tokensUsed.input;
            totalTokensUsed.output += email.analysis.tokensUsed.output;
            totalTokensUsed.total += email.analysis.tokensUsed.total;
          }
        });

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
            tokensUsed: overallSummary.tokensUsed,
          },
          tokensUsed: totalTokensUsed,
        };
      }

      // Calculer le total des tokens utilisés pour l'analyse des emails
      const totalTokensUsed = {
        input: 0,
        output: 0,
        total: 0,
      };

      analyzedEmails.forEach((email) => {
        if (email.analysis?.tokensUsed) {
          totalTokensUsed.input += email.analysis.tokensUsed.input;
          totalTokensUsed.output += email.analysis.tokensUsed.output;
          totalTokensUsed.total += email.analysis.tokensUsed.total;
        }
      });

      return {
        status: 'success',
        message: `${analyzedEmails.length} emails non lus analysés avec succès`,
        data: analyzedEmails,
        tokensUsed: totalTokensUsed,
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
   */
  @Get('today/summary')
  async getTodayEmailsSummary(): Promise<{
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
      tokensUsed?: {
        input: number;
        output: number;
        total: number;
      };
    };
    tokensUsed?: {
      input: number;
      output: number;
      total: number;
    };
  }> {
    try {
      this.logger.log(
        `Génération du résumé des emails non lus d'aujourd'hui dans tous les dossiers`,
      );

      // Récupération et analyse des emails
      const todayEmails = await this.analyzeEmailService.getTodayEmails();

      if (todayEmails.length === 0) {
        return {
          status: 'success',
          message: `Aucun email non lu trouvé pour aujourd'hui dans tous les dossiers`,
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

      // Calculer le total des tokens utilisés (analyse d'emails + résumé)
      const totalTokensUsed = {
        input: overallSummary.tokensUsed?.input || 0,
        output: overallSummary.tokensUsed?.output || 0,
        total: overallSummary.tokensUsed?.total || 0,
      };

      // Ajouter les tokens utilisés par l'analyse individuelle des emails
      analyzedEmails.forEach((email) => {
        if (email.analysis?.tokensUsed) {
          totalTokensUsed.input += email.analysis.tokensUsed.input;
          totalTokensUsed.output += email.analysis.tokensUsed.output;
          totalTokensUsed.total += email.analysis.tokensUsed.total;
        }
      });

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
          tokensUsed: overallSummary.tokensUsed,
        },
        tokensUsed: totalTokensUsed,
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
   * Récupère et analyse tous les emails du jour (lus et non lus)
   * @param summary Si true, inclut un résumé général des emails (optionnel, par défaut: false)
   */
  @Get('today/all')
  async analyzeAllTodayEmails(@Query('summary') summary?: string): Promise<{
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
        `Début de l'analyse de tous les emails d'aujourd'hui dans tous les dossiers`,
      );

      // Récupération de tous les emails du jour (lus et non lus)
      const todayEmails = await this.analyzeEmailService.getAllTodayEmails();

      if (todayEmails.length === 0) {
        return {
          status: 'success',
          message: `Aucun email trouvé pour aujourd'hui dans tous les dossiers`,
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
          message: `${analyzedEmails.length} emails analysés avec succès`,
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
        message: `${analyzedEmails.length} emails analysés avec succès`,
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
   * Endpoint dédié au résumé global de tous les emails d'aujourd'hui (lus et non lus)
   */
  @Get('today/all/summary')
  async getAllTodayEmailsSummary(): Promise<{
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
        `Génération du résumé de tous les emails d'aujourd'hui dans tous les dossiers`,
      );

      // Récupération et analyse des emails
      const todayEmails = await this.analyzeEmailService.getAllTodayEmails();

      if (todayEmails.length === 0) {
        return {
          status: 'success',
          message: `Aucun email trouvé pour aujourd'hui dans tous les dossiers`,
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
        message: `Résumé généré pour ${analyzedEmails.length} emails`,
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
   * Endpoint dédié au résumé professionnel des emails (format structuré)
   */
  @Get('professional-summary')
  async getProfessionalSummary(): Promise<{
    status: string;
    message: string;
    professionalSummary: string;
    tokensUsed: {
      input: number;
      output: number;
      total: number;
    };
  }> {
    try {
      this.logger.log(
        `Génération du résumé professionnel des emails non lus dans tous les dossiers`,
      );

      // Récupération et analyse des emails
      const emails = await this.analyzeEmailService.getTodayEmails();

      if (emails.length === 0) {
        return {
          status: 'success',
          message: `Aucun email non lu trouvé dans tous les dossiers`,
          professionalSummary: 'Aucun email à analyser',
          tokensUsed: {
            input: 0,
            output: 0,
            total: 0,
          },
        };
      }

      const analyzedEmails =
        await this.analyzeEmailService.analyzeEmails(emails);
      const overallSummary =
        await this.analyzeEmailService.generateOverallSummary(analyzedEmails);

      // Utiliser le nouveau format professionnel
      const professionalSummaryResult =
        await this.analyzeEmailService.formatProfessionalSummary(
          overallSummary,
        );

      // Calculer le total des tokens utilisés (analyse d'emails + résumé + format professionnel)
      const totalTokensUsed = {
        input: professionalSummaryResult.tokensUsed.input,
        output: professionalSummaryResult.tokensUsed.output,
        total: professionalSummaryResult.tokensUsed.total,
      };

      // Ajouter les tokens utilisés par l'analyse individuelle des emails
      analyzedEmails.forEach((email) => {
        if (email.analysis?.tokensUsed) {
          totalTokensUsed.input += email.analysis.tokensUsed.input;
          totalTokensUsed.output += email.analysis.tokensUsed.output;
          totalTokensUsed.total += email.analysis.tokensUsed.total;
        }
      });

      return {
        status: 'success',
        message: `Résumé professionnel généré pour ${analyzedEmails.length} emails non lus`,
        professionalSummary: professionalSummaryResult.formattedSummary,
        tokensUsed: totalTokensUsed,
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Erreur lors de la génération du résumé professionnel: ${errorMessage}`,
      );
      throw new HttpException(
        {
          status: 'error',
          message: `Erreur lors de la génération du résumé professionnel: ${errorMessage}`,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Endpoint dédié au résumé professionnel de tous les emails (lus et non lus)
   */
  @Get('professional-summary/all')
  async getAllProfessionalSummary(): Promise<{
    status: string;
    message: string;
    professionalSummary: string;
    tokensUsed: {
      input: number;
      output: number;
      total: number;
    };
  }> {
    try {
      this.logger.log(
        `Génération du résumé professionnel de tous les emails dans tous les dossiers`,
      );

      // Récupération et analyse des emails
      const emails = await this.analyzeEmailService.getAllTodayEmails();

      if (emails.length === 0) {
        return {
          status: 'success',
          message: `Aucun email trouvé dans tous les dossiers`,
          professionalSummary: 'Aucun email à analyser',
          tokensUsed: {
            input: 0,
            output: 0,
            total: 0,
          },
        };
      }

      const analyzedEmails =
        await this.analyzeEmailService.analyzeEmails(emails);
      const overallSummary =
        await this.analyzeEmailService.generateOverallSummary(analyzedEmails);

      // Utiliser le nouveau format professionnel
      const professionalSummaryResult =
        await this.analyzeEmailService.formatProfessionalSummary(
          overallSummary,
        );

      // Calculer le total des tokens utilisés (analyse d'emails + résumé + format professionnel)
      const totalTokensUsed = {
        input: professionalSummaryResult.tokensUsed.input,
        output: professionalSummaryResult.tokensUsed.output,
        total: professionalSummaryResult.tokensUsed.total,
      };

      // Ajouter les tokens utilisés par l'analyse individuelle des emails
      analyzedEmails.forEach((email) => {
        if (email.analysis?.tokensUsed) {
          totalTokensUsed.input += email.analysis.tokensUsed.input;
          totalTokensUsed.output += email.analysis.tokensUsed.output;
          totalTokensUsed.total += email.analysis.tokensUsed.total;
        }
      });

      return {
        status: 'success',
        message: `Résumé professionnel généré pour ${analyzedEmails.length} emails (lus et non lus)`,
        professionalSummary: professionalSummaryResult.formattedSummary,
        tokensUsed: totalTokensUsed,
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Erreur lors de la génération du résumé professionnel: ${errorMessage}`,
      );
      throw new HttpException(
        {
          status: 'error',
          message: `Erreur lors de la génération du résumé professionnel: ${errorMessage}`,
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
