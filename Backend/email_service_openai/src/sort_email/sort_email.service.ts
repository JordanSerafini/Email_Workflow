import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Imap from 'node-imap';
import { simpleParser, ParsedMail } from 'mailparser';
import OpenAI from 'openai';
import { Readable } from 'stream';
import { Email } from './models/email.model';

// Interfaces pour typer IMAP
type ImapBox = Record<string, any>;

interface ImapMessage {
  on(event: string, callback: (stream: Readable, info: any) => void): void;
}

interface ImapFetch {
  on(event: string, callback: (msg: ImapMessage, seqno: number) => void): void;
  once(event: string, callback: (err: Error) => void): void;
}

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

@Injectable()
export class SortEmailService implements OnModuleInit {
  private readonly logger = new Logger(SortEmailService.name);
  private imap: any;
  private openai: OpenAI;
  private categories: string[];

  constructor(private configService: ConfigService) {
    this.openai = new OpenAI({
      apiKey: this.configService.get<string>('OPENAI_API_KEY'),
    });

    this.categories = this.configService
      .get<string>(
        'EMAIL_CATEGORIES',
        'Urgent,Important,Newsletter,Spam,Commercial,Personnel,Professionnel,Factures,Autre',
      )
      .split(',');

    // Créer l'instance IMAP avec le type any pour éviter les erreurs TypeScript
    this.imap = new Imap({
      user: this.configService.get<string>('EMAIL_USER') || '',
      password: this.configService.get<string>('EMAIL_PASSWORD') || '',
      host: this.configService.get<string>('EMAIL_HOST') || '',
      port: this.configService.get<number>('EMAIL_PORT', 993),
      tls: this.configService.get<boolean>('EMAIL_TLS', true),
    });
  }

  async onModuleInit() {
    try {
      await this.connectToImap();
      this.logger.log('Successfully connected to email server');
    } catch (error: unknown) {
      this.logger.error(
        `Failed to connect to email server: ${getErrorMessage(error)}`,
      );
    }
  }

  async connectToImap(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // Utilisation de any pour éviter les erreurs de type
      const imap = this.imap;

      imap.once('ready', () => {
        resolve();
      });

      imap.once('error', (err: unknown) => {
        reject(new Error(getErrorMessage(err)));
      });

      imap.connect();
    });
  }

  async getUnsortedEmails(): Promise<Email[]> {
    return new Promise<Email[]>((resolve, reject) => {
      // Utilisation de any pour éviter les erreurs de type
      const imap = this.imap;

      imap.openBox('INBOX', false, (err: unknown) => {
        if (err) {
          return reject(new Error(getErrorMessage(err)));
        }

        const emails: Email[] = [];

        imap.search(['UNSEEN'], (searchErr: unknown, results: any) => {
          if (searchErr) {
            return reject(new Error(getErrorMessage(searchErr)));
          }

          if (!results || results.length === 0) {
            return resolve([]);
          }

          // Typé en any pour éviter les erreurs
          const f = imap.fetch(results, {
            bodies: [''],
            struct: true,
          }) as ImapFetch;

          f.on('message', (msg: ImapMessage, seqno: number) => {
            const email: Partial<Email> = { id: String(seqno) };

            msg.on('body', (stream: Readable, _info: any) => {
              let buffer = '';
              stream.on('data', (chunk: Buffer) => {
                buffer += chunk.toString('utf8');
              });

              stream.once('end', () => {
                // Utiliser void pour éviter l'erreur de promesse
                void (async () => {
                  try {
                    // Typer le résultat de simpleParser
                    const parsed = (await simpleParser(
                      buffer,
                    )) as unknown as ParsedMail;
                    // Accéder aux propriétés de manière sécurisée
                    email.from =
                      typeof parsed.from?.text === 'string'
                        ? parsed.from.text
                        : '';
                    email.to =
                      typeof parsed.to?.text === 'string' ? parsed.to.text : '';
                    email.subject =
                      typeof parsed.subject === 'string' ? parsed.subject : '';
                    email.date =
                      parsed.date instanceof Date ? parsed.date : new Date();
                    email.body =
                      typeof parsed.text === 'string' ? parsed.text : '';

                    emails.push(email as Email);
                  } catch (e: unknown) {
                    this.logger.error(
                      `Error parsing email: ${getErrorMessage(e)}`,
                    );
                  }
                })();
              });
            });
          });

          f.once('error', (fetchErr: unknown) => {
            reject(new Error(getErrorMessage(fetchErr)));
          });

          f.once('end', () => {
            resolve(emails);
          });
        });
      });
    });
  }

  async categorizeEmail(email: Email): Promise<string> {
    try {
      const prompt = `
        Analyse l'email suivant et classe-le dans l'une des catégories suivantes: ${this.categories.join(', ')}.
        
        De: ${email.from}
        À: ${email.to}
        Sujet: ${email.subject}
        Date: ${email.date.toISOString()}
        Contenu: ${email.body.substring(0, 1000)}
        
        Réponds uniquement avec le nom de la catégorie la plus appropriée.
      `;

      const response = await this.openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content:
              "Tu es un assistant spécialisé dans le tri d'emails. Tu dois classifier les emails dans les catégories spécifiées de manière précise.",
          },
          { role: 'user', content: prompt },
        ],
        max_tokens: 50,
        temperature: 0.3,
      });

      // Extraire la catégorie de la réponse
      const predictedCategory =
        response.choices[0]?.message?.content?.trim() || 'Autre';

      // Vérifier si la catégorie est dans la liste des catégories acceptées
      const validCategory =
        this.categories.find(
          (category) =>
            category.toLowerCase() === predictedCategory.toLowerCase(),
        ) || 'Autre';

      return validCategory;
    } catch (error: unknown) {
      this.logger.error(`Error categorizing email: ${getErrorMessage(error)}`);
      return 'Autre';
    }
  }

  /**
   * Tri les emails en utilisant l'API OpenAI
   * Les catégories incluent désormais "Factures" pour isoler les factures
   * qui seront ensuite analysées par un agent IA dédié
   */
  async sortEmails(): Promise<{ [category: string]: Email[] }> {
    try {
      const emails = await this.getUnsortedEmails();
      const sortedEmails: { [category: string]: Email[] } = {};

      // Initialiser les catégories
      this.categories.forEach((category) => {
        sortedEmails[category] = [];
      });

      // Trier chaque email
      for (const email of emails) {
        const category = await this.categorizeEmail(email);
        email.category = category;
        sortedEmails[category].push(email);
      }

      return sortedEmails;
    } catch (error: unknown) {
      this.logger.error(`Error sorting emails: ${getErrorMessage(error)}`);
      throw error;
    }
  }

  /**
   * Analyse les factures triées pour en extraire les informations importantes
   * Cette méthode sera utilisée par un agent IA dédié
   */
  async analyzeInvoices(invoiceEmails: Email[]): Promise<any[]> {
    const analyzedInvoices = [];

    try {
      this.logger.log(`Analyzing ${invoiceEmails.length} invoice emails`);

      for (const email of invoiceEmails) {
        // Analyse de base de la facture
        const invoiceData = await this.extractInvoiceData(email);
        analyzedInvoices.push(invoiceData);
      }

      return analyzedInvoices;
    } catch (error: unknown) {
      this.logger.error(`Error analyzing invoices: ${getErrorMessage(error)}`);
      return [];
    }
  }

  /**
   * Extrait les informations de facture d'un email
   * Utilise OpenAI pour analyser le contenu de l'email
   */
  private async extractInvoiceData(email: Email): Promise<any> {
    try {
      const prompt = `
        Analyse cet email de facture et extrait les informations suivantes:
        - Montant total
        - Date de la facture
        - Numéro de facture
        - Émetteur
        - Date d'échéance
        
        Email:
        De: ${email.from}
        Sujet: ${email.subject}
        Date: ${email.date.toISOString()}
        Contenu: ${email.body}
        
        Réponds au format JSON uniquement.
      `;

      const response = await this.openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content:
              "Tu es un assistant spécialisé dans l'analyse de factures. Extrait les informations structurées au format JSON.",
          },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 500,
        temperature: 0.1,
      });

      const resultContent = response.choices[0]?.message?.content || '{}';
      let invoiceData;

      try {
        invoiceData = JSON.parse(resultContent);
      } catch (e) {
        invoiceData = { error: 'Impossible de parser la réponse JSON' };
      }

      return {
        emailId: email.id,
        subject: email.subject,
        date: email.date,
        invoiceData,
      };
    } catch (error: unknown) {
      this.logger.error(
        `Error extracting invoice data: ${getErrorMessage(error)}`,
      );
      return {
        emailId: email.id,
        error: getErrorMessage(error),
      };
    }
  }

  async moveEmailToCategory(email: Email): Promise<void> {
    if (!email.category) {
      this.logger.warn(`Email ${email.id} has no category assigned`);
      return;
    }

    return new Promise<void>((resolve, reject) => {
      // Utilisation de any pour éviter les erreurs de type
      const imap = this.imap;

      imap.openBox('INBOX', false, (err: unknown) => {
        if (err) {
          return reject(new Error(getErrorMessage(err)));
        }

        imap.addFlags(email.id, '\\Seen', (flagErr: unknown) => {
          if (flagErr) {
            this.logger.error(
              `Error marking email as read: ${getErrorMessage(flagErr)}`,
            );
          }

          // Créer le dossier de catégorie si nécessaire
          imap.getBoxes((boxErr: unknown, boxes: Record<string, ImapBox>) => {
            if (boxErr) {
              return reject(new Error(getErrorMessage(boxErr)));
            }

            // Puisque nous avons déjà vérifié que email.category n'est pas undefined au début de la fonction
            const categoryName = email.category as string;

            const categoryExists = Object.keys(boxes).some(
              (key) => key.toLowerCase() === categoryName.toLowerCase(),
            );

            const createBoxIfNeeded = () => {
              if (!categoryExists) {
                imap.addBox(categoryName, (addBoxErr: unknown) => {
                  if (addBoxErr) {
                    this.logger.error(
                      `Error creating category folder: ${getErrorMessage(addBoxErr)}`,
                    );
                    return resolve(); // Continue même en cas d'erreur
                  }
                  moveEmail();
                });
              } else {
                moveEmail();
              }
            };

            const moveEmail = () => {
              imap.move(email.id, categoryName, (moveErr: unknown) => {
                if (moveErr) {
                  this.logger.error(
                    `Error moving email to category: ${getErrorMessage(moveErr)}`,
                  );
                }
                resolve();
              });
            };

            createBoxIfNeeded();
          });
        });
      });
    });
  }

  async processSortedEmails(sortedEmails: {
    [category: string]: Email[];
  }): Promise<void> {
    try {
      for (const category of Object.keys(sortedEmails)) {
        for (const email of sortedEmails[category]) {
          await this.moveEmailToCategory(email);
        }
      }
      this.logger.log('All emails have been sorted and moved');
    } catch (error: unknown) {
      this.logger.error(
        `Error processing sorted emails: ${getErrorMessage(error)}`,
      );
    }
  }
}
