import { Controller, Get, Post, Logger } from '@nestjs/common';
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
      const sortedEmails = await this.sortEmailService.sortEmails();
      await this.sortEmailService.processSortedEmails(sortedEmails);

      // Préparer une réponse avec des statistiques
      const stats = Object.entries(sortedEmails).map(([category, emails]) => ({
        category,
        count: emails.length,
      }));

      return {
        success: true,
        message: 'Emails triés avec succès',
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

  /**
   * Endpoint pour analyser les factures
   * Tri d'abord les emails, puis analyse spécifiquement les factures
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

      // Déplacer les emails vers leurs catégories
      await this.sortEmailService.processSortedEmails(sortedEmails);

      return {
        success: true,
        message: `${analyzedInvoices.length} factures analysées avec succès`,
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
}
