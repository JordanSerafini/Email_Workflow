export class Email {
  id: string;
  uid?: number;  // UID IMAP pour un suivi plus précis
  from: string;
  to: string;
  subject: string;
  body: string;
  date: Date;
  category?: string;
} 