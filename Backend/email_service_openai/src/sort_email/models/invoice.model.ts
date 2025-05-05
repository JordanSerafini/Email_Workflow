/**
 * Interface représentant les données extraites d'une facture
 */
export interface InvoiceData {
  montantTotal?: string | number;
  dateFacture?: string | Date;
  numeroFacture?: string;
  emetteur?: string;
  dateEcheance?: string | Date;
  [key: string]: any; // Pour permettre des champs supplémentaires
}

/**
 * Interface représentant une facture analysée
 */
export interface AnalyzedInvoice {
  emailId: string;
  subject: string;
  date: Date;
  invoiceData: InvoiceData;
  error?: string;
} 