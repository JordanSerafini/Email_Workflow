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
   * @param fastMode Si true, effectue une analyse rapide avec moins de détails (optionnel, par défaut: false)
   */
  @Get('today')
  async analyzeTodayEmails(
    @Query('summary') summary?: string,
    @Query('fastMode') fastMode?: string,
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

      // Analyse des emails récupérés (mode rapide si spécifié)
      const analyzedEmails = await this.analyzeEmailService.analyzeEmails(
        todayEmails,
        fastMode === 'true',
      );

      // Si résumé demandé, générer un résumé global
      if (summary === 'true') {
        const overallSummary =
          await this.analyzeEmailService.generateOverallSummary(
            analyzedEmails,
            fastMode === 'true',
          );

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
          message: `${analyzedEmails.length} emails non lus analysés avec succès${fastMode === 'true' ? ' (mode rapide)' : ''}`,
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
        message: `${analyzedEmails.length} emails non lus analysés avec succès${fastMode === 'true' ? ' (mode rapide)' : ''}`,
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
   * @param fastMode Si true, utilise un mode rapide avec analyse optimisée (optionnel, par défaut: false)
   */
  @Get('today/all')
  async analyzeAllTodayEmails(
    @Query('summary') summary?: string,
    @Query('fastMode') fastMode?: string,
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
      tokensUsed?: {
        input: number;
        output: number;
        total: number;
      };
    };
    performanceMetrics?: {
      totalDuration: number;
      emailFetchDuration: number;
      analysisDuration: number;
      summaryDuration?: number;
    };
  }> {
    try {
      const startTime = Date.now();
      const isFastMode = fastMode === 'true';

      this.logger.log(
        `Début de l'analyse de tous les emails d'aujourd'hui dans tous les dossiers${isFastMode ? ' (mode rapide)' : ''}`,
      );

      // Récupération de tous les emails du jour (lus et non lus)
      const fetchStartTime = Date.now();
      const todayEmails = await this.analyzeEmailService.getAllTodayEmails();
      const fetchEndTime = Date.now();

      if (todayEmails.length === 0) {
        return {
          status: 'success',
          message: `Aucun email trouvé pour aujourd'hui dans tous les dossiers`,
          data: [],
          performanceMetrics: {
            totalDuration: Date.now() - startTime,
            emailFetchDuration: fetchEndTime - fetchStartTime,
            analysisDuration: 0,
          },
        };
      }

      // Analyse des emails récupérés
      const analysisStartTime = Date.now();
      const analyzedEmails = await this.analyzeEmailService.analyzeEmails(
        todayEmails,
        isFastMode,
      );
      const analysisEndTime = Date.now();

      // Métriques de performance de base
      const performanceMetrics: {
        totalDuration: number;
        emailFetchDuration: number;
        analysisDuration: number;
        summaryDuration?: number;
      } = {
        totalDuration: 0, // Sera mis à jour à la fin
        emailFetchDuration: fetchEndTime - fetchStartTime,
        analysisDuration: analysisEndTime - analysisStartTime,
      };

      // Si résumé demandé, générer un résumé global
      if (summary === 'true') {
        const summaryStartTime = Date.now();
        const overallSummary =
          await this.analyzeEmailService.generateOverallSummary(
            analyzedEmails,
            isFastMode,
          );
        const summaryEndTime = Date.now();

        // Mettre à jour les métriques avec le temps de génération du résumé
        performanceMetrics.summaryDuration = summaryEndTime - summaryStartTime;
        performanceMetrics.totalDuration = Date.now() - startTime;

        this.logger.log(
          `Analyse complète en ${performanceMetrics.totalDuration}ms (récupération: ${performanceMetrics.emailFetchDuration}ms, analyse: ${performanceMetrics.analysisDuration}ms, résumé: ${performanceMetrics.summaryDuration}ms)`,
        );

        return {
          status: 'success',
          message: `${analyzedEmails.length} emails analysés avec succès${isFastMode ? ' (mode rapide)' : ''}`,
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
          performanceMetrics,
        };
      }

      // Finaliser les métriques de performance sans résumé
      performanceMetrics.totalDuration = Date.now() - startTime;

      this.logger.log(
        `Analyse complète en ${performanceMetrics.totalDuration}ms (récupération: ${performanceMetrics.emailFetchDuration}ms, analyse: ${performanceMetrics.analysisDuration}ms)`,
      );

      return {
        status: 'success',
        message: `${analyzedEmails.length} emails analysés avec succès${isFastMode ? ' (mode rapide)' : ''}`,
        data: analyzedEmails,
        performanceMetrics,
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
   * @param limit Nombre maximum d'emails à analyser (optionnel)
   * @param fastMode Si true, utilise un mode rapide avec analyse optimisée (optionnel, par défaut: false)
   */
  @Get('today/all/summary')
  async getAllTodayEmailsSummary(
    @Query('limit') limit?: string,
    @Query('fastMode') fastMode?: string,
  ): Promise<{
    status: string;
    message: string;
    data: EmailContent[];
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
    performanceMetrics?: {
      totalDuration: number;
      emailFetchDuration: number;
      analysisDuration: number;
      summaryDuration: number;
    };
  }> {
    try {
      const startTime = Date.now();
      const isFastMode = fastMode === 'true';

      this.logger.log(
        `Génération du résumé de tous les emails d'aujourd'hui dans tous les dossiers${isFastMode ? ' (mode rapide)' : ''}`,
      );

      // Log de la valeur brute du paramètre limit
      this.logger.log(`Paramètre limit reçu: "${limit}"`);

      // Récupération des emails
      const fetchStartTime = Date.now();
      const todayEmails = await this.analyzeEmailService.getAllTodayEmails();
      const fetchEndTime = Date.now();

      this.logger.log(`Nombre total d'emails récupérés: ${todayEmails.length}`);

      if (todayEmails.length === 0) {
        return {
          status: 'success',
          message: `Aucun email trouvé pour aujourd'hui dans tous les dossiers`,
          data: [],
          summary: {
            overview: 'Aucun email à analyser',
            totalEmails: 0,
            highPriorityCount: 0,
            actionRequiredCount: 0,
            categoryCounts: {},
            topPriorityEmails: [],
            actionItems: [],
          },
          performanceMetrics: {
            totalDuration: Date.now() - startTime,
            emailFetchDuration: fetchEndTime - fetchStartTime,
            analysisDuration: 0,
            summaryDuration: 0,
          },
        };
      }

      // Appliquer la limite d'emails si spécifiée
      const limitValue = limit ? parseInt(limit, 10) : undefined;
      this.logger.log(`Valeur de limite après parsing: ${limitValue}`);

      // Vérifier que limitValue est un nombre valide
      if (limitValue !== undefined && (isNaN(limitValue) || limitValue <= 0)) {
        this.logger.warn(
          `Valeur de limite invalide: ${limitValue}, utilisation de tous les emails`,
        );
      }

      const emailsToAnalyze =
        limitValue && limitValue > 0
          ? todayEmails.slice(0, limitValue)
          : todayEmails;

      this.logger.log(
        `Analyse de ${emailsToAnalyze.length}/${todayEmails.length} emails (limite: ${limitValue || 'aucune'})${isFastMode ? ' en mode rapide' : ''}`,
      );

      // Analyse des emails
      const analysisStartTime = Date.now();
      const analyzedEmails = await this.analyzeEmailService.analyzeEmails(
        emailsToAnalyze,
        isFastMode,
      );
      const analysisEndTime = Date.now();

      // Génération du résumé
      const summaryStartTime = Date.now();
      const overallSummary =
        await this.analyzeEmailService.generateOverallSummary(
          analyzedEmails,
          isFastMode,
        );
      const summaryEndTime = Date.now();

      // Calcul des métriques de performance
      const performanceMetrics = {
        totalDuration: Date.now() - startTime,
        emailFetchDuration: fetchEndTime - fetchStartTime,
        analysisDuration: analysisEndTime - analysisStartTime,
        summaryDuration: summaryEndTime - summaryStartTime,
      };

      this.logger.log(
        `Résumé généré en ${performanceMetrics.totalDuration}ms (récupération: ${performanceMetrics.emailFetchDuration}ms, analyse: ${performanceMetrics.analysisDuration}ms, résumé: ${performanceMetrics.summaryDuration}ms)`,
      );

      return {
        status: 'success',
        message: `Résumé généré pour ${analyzedEmails.length}/${todayEmails.length} emails (limite: ${limitValue || 'aucune'})${isFastMode ? ' en mode rapide' : ''}`,
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
        performanceMetrics,
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
   * @param fastMode Si true, utilise un mode rapide avec analyse optimisée (optionnel, par défaut: false)
   */
  @Get('professional-summary')
  async getProfessionalSummary(@Query('fastMode') fastMode?: string): Promise<{
    status: string;
    message: string;
    professionalSummary: string;
    tokensUsed: {
      input: number;
      output: number;
      total: number;
    };
    performanceMetrics?: {
      totalDuration: number;
      emailFetchDuration: number;
      analysisDuration: number;
      summaryDuration: number;
      formattingDuration: number;
    };
  }> {
    try {
      const startTime = Date.now();
      const isFastMode = fastMode === 'true';

      this.logger.log(
        `Génération du résumé professionnel des emails non lus dans tous les dossiers${isFastMode ? ' (mode rapide)' : ''}`,
      );

      // Récupération des emails
      const fetchStartTime = Date.now();
      const emails = await this.analyzeEmailService.getTodayEmails();
      const fetchEndTime = Date.now();

      if (emails.length === 0) {
        return {
          status: 'success',
          message: `Aucun email non lu trouvé dans tous les dossiers`,
          professionalSummary:
            "Bonjour, je n'ai trouvé aucun email non lu dans votre boîte de réception aujourd'hui.",
          tokensUsed: {
            input: 0,
            output: 0,
            total: 0,
          },
          performanceMetrics: {
            totalDuration: Date.now() - startTime,
            emailFetchDuration: fetchEndTime - fetchStartTime,
            analysisDuration: 0,
            summaryDuration: 0,
            formattingDuration: 0,
          },
        };
      }

      // Analyse des emails
      const analysisStartTime = Date.now();
      const analyzedEmails = await this.analyzeEmailService.analyzeEmails(
        emails,
        isFastMode,
      );
      const analysisEndTime = Date.now();

      // Génération du résumé global
      const summaryStartTime = Date.now();
      const overallSummary =
        await this.analyzeEmailService.generateOverallSummary(
          analyzedEmails,
          isFastMode,
        );
      const summaryEndTime = Date.now();

      // Génération du format professionnel
      const formattingStartTime = Date.now();
      const professionalSummaryResult =
        await this.analyzeEmailService.formatProfessionalSummary(
          overallSummary,
          isFastMode,
        );
      const formattingEndTime = Date.now();

      // Calculer les métriques de performance
      const performanceMetrics = {
        totalDuration: Date.now() - startTime,
        emailFetchDuration: fetchEndTime - fetchStartTime,
        analysisDuration: analysisEndTime - analysisStartTime,
        summaryDuration: summaryEndTime - summaryStartTime,
        formattingDuration: formattingEndTime - formattingStartTime,
      };

      this.logger.log(
        `Résumé professionnel généré en ${performanceMetrics.totalDuration}ms (récupération: ${performanceMetrics.emailFetchDuration}ms, analyse: ${performanceMetrics.analysisDuration}ms, résumé: ${performanceMetrics.summaryDuration}ms, formatage: ${performanceMetrics.formattingDuration}ms)`,
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
        message: `Résumé professionnel généré pour ${analyzedEmails.length} emails non lus${isFastMode ? ' (mode rapide)' : ''}`,
        professionalSummary: professionalSummaryResult.formattedSummary,
        tokensUsed: totalTokensUsed,
        performanceMetrics,
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
          professionalSummary:
            "Bonjour, je n'ai trouvé aucun email dans votre boîte de réception aujourd'hui. Tout est à jour!",
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
