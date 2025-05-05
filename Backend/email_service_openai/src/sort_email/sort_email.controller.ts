import { Controller, Get, Post, Logger, Body } from '@nestjs/common';
import { SortEmailService } from './sort_email.service';

interface ErrorWithMessage {
  message: string;
}

function isErrorWithMessage(error: unknown): error is ErrorWithMessage {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as Record<string, unknown>).message === 'string'
  );
}

function getErrorMessage(error: unknown): string {
  if (isErrorWithMessage(error)) {
    return error.message;
  }
  return String(error);
}

@Controller('sort-email')
export class SortEmailController {
  private readonly logger = new Logger(SortEmailController.name);

  constructor(private readonly sortEmailService: SortEmailService) {}

  @Get('status')
  getStatus() {
    return { status: "Service de tri d'emails opérationnel" };
  }

  @Post('sort')
  async sortEmails() {
    try {
      this.logger.log('Démarrage du processus de tri des emails...');
      const sortedEmails = await this.sortEmailService.sortEmails();

      this.logger.log(
        'Emails triés, début du déplacement vers les dossiers appropriés...',
      );
      await this.sortEmailService.processSortedEmails(sortedEmails);
      this.logger.log('Déplacement des emails terminé avec succès');

      // Préparer une réponse avec des statistiques
      const stats = Object.entries(sortedEmails).map(([category, emails]) => ({
        category,
        count: emails.length,
      }));

      return {
        success: true,
        message: 'Emails triés et déplacés avec succès',
        stats,
      };
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      this.logger.error(`Erreur lors du tri des emails: ${errorMessage}`);
      return {
        success: false,
        message: 'Erreur lors du tri des emails',
        error: errorMessage,
      };
    }
  }

  @Post('sort-all')
  async sortAllEmails() {
    try {
      this.logger.log('Démarrage du processus de tri de tous les emails...');
      const sortedEmails = await this.sortEmailService.sortAllEmails();

      this.logger.log(
        'Tous les emails triés, début du déplacement vers les dossiers appropriés...',
      );
      await this.sortEmailService.processSortedEmails(sortedEmails);
      this.logger.log('Déplacement de tous les emails terminé avec succès');

      // Préparer une réponse avec des statistiques
      const stats = Object.entries(sortedEmails).map(([category, emails]) => ({
        category,
        count: emails.length,
      }));

      return {
        success: true,
        message: 'Tous les emails triés et déplacés avec succès',
        stats,
      };
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      this.logger.error(
        `Erreur lors du tri de tous les emails: ${errorMessage}`,
      );
      return {
        success: false,
        message: 'Erreur lors du tri de tous les emails',
        error: errorMessage,
      };
    }
  }

  /**
   * Endpoint pour analyser les factures
   * Tri d'abord les emails, puis analyse spécifiquement les factures
   * SANS déplacer ou classer les emails
   */
  @Post('analyze-invoices')
  async analyzeInvoices() {
    try {
      // D'abord trier les emails
      const sortedEmails = await this.sortEmailService.sortEmails();

      // Récupérer les emails classés comme "Factures"
      const invoiceEmails = sortedEmails['Factures'] || [];

      if (invoiceEmails.length === 0) {
        return {
          success: true,
          message: 'Aucune facture trouvée pour analyse',
          invoices: [],
        };
      }

      // Analyser les factures
      const analyzedInvoices =
        await this.sortEmailService.analyzeInvoices(invoiceEmails);

      // NE PAS déplacer les emails vers leurs catégories
      // await this.sortEmailService.processSortedEmails(sortedEmails);

      return {
        success: true,
        message: `${analyzedInvoices.length} factures analysées avec succès (sans déplacement)`,
        invoices: analyzedInvoices,
      };
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      this.logger.error(
        `Erreur lors de l'analyse des factures: ${errorMessage}`,
      );
      return {
        success: false,
        message: "Erreur lors de l'analyse des factures",
        error: errorMessage,
      };
    }
  }

  @Post('sort-by-category')
  async sortByCategory(@Body() body: { category: string }): Promise<{
    success: boolean;
    message: string;
    emailsProcessed: number;
  }> {
    try {
      const { category } = body;
      if (!category) {
        return {
          success: false,
          message: 'Le nom de la catégorie est requis',
          emailsProcessed: 0,
        };
      }

      // Appeler le service pour trier les emails par catégorie
      const emailsProcessed =
        await this.sortEmailService.sortEmailsByCategory(category);

      return {
        success: true,
        message: `Traitement terminé. ${emailsProcessed} email(s) classé(s) dans la catégorie "${category}"`,
        emailsProcessed,
      };
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      return {
        success: false,
        message: `Erreur: ${errorMessage}`,
        emailsProcessed: 0,
      };
    }
  }

  /**
   * Endpoint pour analyser tous les emails non lus dans tous les dossiers
   * SANS déplacer ou classer les emails
   */
  @Post('analyze-all-folders/unread')
  async analyzeUnreadEmailsFromAllFolders() {
    try {
      // Trier les emails non lus de tous les dossiers (sans déplacement)
      const sortedEmails =
        await this.sortEmailService.sortEmailsFromAllFolders();

      // Récupérer les emails classés comme "Factures"
      const invoiceEmails = sortedEmails['Factures'] || [];

      if (invoiceEmails.length === 0) {
        return {
          success: true,
          message:
            'Aucune facture non lue trouvée pour analyse dans tous les dossiers',
          invoices: [],
        };
      }

      // Analyser les factures
      const analyzedInvoices =
        await this.sortEmailService.analyzeInvoices(invoiceEmails);

      // NE PAS déplacer les emails vers leurs catégories
      // await this.sortEmailService.processSortedEmails(sortedEmails);

      return {
        success: true,
        message: `${analyzedInvoices.length} factures non lues analysées avec succès depuis tous les dossiers (sans déplacement)`,
        invoices: analyzedInvoices,
      };
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      this.logger.error(
        `Erreur lors de l'analyse des factures non lues de tous les dossiers: ${errorMessage}`,
      );
      return {
        success: false,
        message:
          "Erreur lors de l'analyse des factures non lues de tous les dossiers",
        error: errorMessage,
      };
    }
  }

  /**
   * Endpoint pour analyser tous les emails (lus et non lus) dans tous les dossiers
   * SANS déplacer ou classer les emails
   */
  @Post('analyze-all-folders/all')
  async analyzeAllEmailsFromAllFolders() {
    try {
      // Trier tous les emails de tous les dossiers (sans déplacement)
      const sortedEmails =
        await this.sortEmailService.sortAllEmailsFromAllFolders();

      // Récupérer les emails classés comme "Factures"
      const invoiceEmails = sortedEmails['Factures'] || [];

      if (invoiceEmails.length === 0) {
        return {
          success: true,
          message: 'Aucune facture trouvée pour analyse dans tous les dossiers',
          invoices: [],
        };
      }

      // Analyser les factures
      const analyzedInvoices =
        await this.sortEmailService.analyzeInvoices(invoiceEmails);

      // NE PAS déplacer les emails vers leurs catégories
      // await this.sortEmailService.processSortedEmails(sortedEmails);

      return {
        success: true,
        message: `${analyzedInvoices.length} factures analysées avec succès depuis tous les dossiers (lues et non lues, sans déplacement)`,
        invoices: analyzedInvoices,
        totalEmails: Object.values(sortedEmails).flat().length,
        emailsByCategory: Object.fromEntries(
          Object.entries(sortedEmails).map(([category, emails]) => [
            category,
            emails.length,
          ]),
        ),
      };
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      this.logger.error(
        `Erreur lors de l'analyse des factures de tous les dossiers: ${errorMessage}`,
      );
      return {
        success: false,
        message: "Erreur lors de l'analyse des factures de tous les dossiers",
        error: errorMessage,
      };
    }
  }
}
