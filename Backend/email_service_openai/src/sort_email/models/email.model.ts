export interface Email {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: Date;
  body: string;
  category?: string;
}
