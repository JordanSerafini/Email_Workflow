import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Imap from 'node-imap';
import { simpleParser } from 'mailparser';
import OpenAI from 'openai';

// Exporter l'interface pour qu'elle soit disponible dans le contrôleur
export interface EmailContent {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: Date;
  body: string;
  analysis?: {
    summary: string;
    priority: 'high' | 'medium' | 'low';
    category: string;
    actionRequired: boolean;
    actionItems?: string[];
  };
}

interface TypedImap {
  state?: string;
  once(event: string, callback: (...args: any[]) => void): void;
  on(event: string, callback: (...args: any[]) => void): void;
  connect(): void;
  openBox(
    name: string,
    readOnly: boolean,
    callback: (err: Error | null, box: any) => void,
  ): void;
  search(
    criteria: any[],
    callback: (err: Error | null, results: any[]) => void,
  ): void;
  fetch(source: any, options: any): any;
  end(): void;
}

@Injectable()
export class AnalyzeEmailService {
  private readonly logger = new Logger(AnalyzeEmailService.name);
  private imap: TypedImap;
  private openai: OpenAI;

  constructor(private configService: ConfigService) {
    this.openai = new OpenAI({
      apiKey: this.configService.get<string>('OPENAI_API_KEY'),
    });

    // Configuration IMAP
    const imapConfig = {
      user: this.configService.get<string>('EMAIL_USER') || '',
      password: this.configService.get<string>('EMAIL_PASSWORD') || '',
      host: this.configService.get<string>('IMAP_HOST') || '',
      port: parseInt(this.configService.get<string>('IMAP_PORT') || '993', 10),
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      debug: (info: any) => this.logger.debug(`IMAP Debug: ${info}`),
    };

    this.logger.log(
      `Configuration IMAP: ${imapConfig.host}:${imapConfig.port}, utilisateur: ${imapConfig.user}`,
    );
    this.imap = new Imap(imapConfig) as unknown as TypedImap;
  }

  /**
   * Établit la connexion IMAP
   */
  private async connectToImap(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.imap.once('ready', () => {
        this.logger.log('Connexion IMAP établie avec succès');
        resolve();
      });

      this.imap.once('error', (err: Error) => {
        this.logger.error(`Erreur de connexion IMAP: ${err.message}`);
        reject(new Error(`Erreur de connexion IMAP: ${err.message}`));
      });

      this.imap.once('end', () => {
        this.logger.log('Connexion IMAP terminée');
      });

      this.imap.connect();
    });
  }

  /**
   * Récupère les emails non lus d'aujourd'hui
   * @param mailboxName Nom de la boîte aux lettres à analyser (par défaut: 'INBOX')
   */
  async getTodayEmails(mailboxName: string = 'INBOX'): Promise<EmailContent[]> {
    try {
      await this.connectToImap();

      await new Promise<void>((resolve, reject) => {
        this.imap.openBox(mailboxName, true, (err: any) => {
          if (err) {
            this.logger.error(
              `Erreur lors de l'ouverture de la boîte ${mailboxName}: ${err.message}`,
            );
            return reject(
              new Error(
                `Erreur lors de l'ouverture de la boîte ${mailboxName}: ${err.message}`,
              ),
            );
          }
          resolve();
        });
      });

      // Obtient la date d'aujourd'hui au format IMAP
      const today = new Date();
      const day = today.getDate().toString().padStart(2, '0');
      const month = [
        'Jan',
        'Feb',
        'Mar',
        'Apr',
        'May',
        'Jun',
        'Jul',
        'Aug',
        'Sep',
        'Oct',
        'Nov',
        'Dec',
      ][today.getMonth()];
      const year = today.getFullYear();

      const searchDate = `${day}-${month}-${year}`;
      this.logger.log(
        `Recherche des emails non lus dans ${mailboxName} pour la date: ${searchDate}`,
      );

      const emails = await new Promise<EmailContent[]>((resolve, reject) => {
        this.imap.search(
          ['UNSEEN', ['ON', searchDate]],
          (searchErr: any, results: any[]) => {
            if (searchErr) {
              this.logger.error(
                `Erreur lors de la recherche des emails: ${searchErr.message}`,
              );
              return reject(
                new Error(
                  `Erreur lors de la recherche des emails: ${searchErr.message}`,
                ),
              );
            }

            if (!results || results.length === 0) {
              this.logger.log("Aucun email non lu trouvé pour aujourd'hui");
              return resolve([]);
            }

            this.logger.log(
              `${results.length} emails non lus trouvés pour aujourd'hui. Chargement du contenu...`,
            );

            const emailPromises: Promise<EmailContent>[] = [];
            const fetch = this.imap.fetch(results, {
              bodies: [''],
              struct: true,
            });

            fetch.on('message', (msg: any, seqno: number) => {
              const emailPromise = new Promise<EmailContent>(
                (resolveEmail, rejectEmail) => {
                  const email: Partial<EmailContent> = { id: String(seqno) };

                  msg.on('body', (stream: any) => {
                    let buffer = '';
                    stream.on('data', (chunk: any) => {
                      buffer += chunk.toString('utf8');
                    });

                    stream.once('end', async () => {
                      try {
                        this.logger.debug(
                          `Parsing du contenu de l'email #${seqno}`,
                        );
                        const parsed = await simpleParser(buffer);

                        email.from = parsed.from?.text || '';
                        email.to = parsed.to?.text || '';
                        email.subject = parsed.subject || '';
                        email.date = parsed.date || new Date();
                        email.body = parsed.text || '';

                        this.logger.debug(
                          `Email #${seqno} parsé avec succès: ${email.subject}`,
                        );

                        resolveEmail(email as EmailContent);
                      } catch (e: any) {
                        this.logger.error(
                          `Erreur lors du parsing de l'email #${seqno}: ${e.message}`,
                        );
                        rejectEmail(
                          new Error(
                            `Erreur lors du parsing de l'email #${seqno}: ${e.message}`,
                          ),
                        );
                      }
                    });
                  });
                },
              );

              emailPromises.push(emailPromise);
            });

            fetch.once('end', () => {
              Promise.all(emailPromises)
                .then((emails) => resolve(emails))
                .catch((error) => reject(error));
            });
          },
        );
      });

      this.logger.log(`${emails.length} emails récupérés avec succès`);
      return emails;
    } catch (error: any) {
      this.logger.error(
        `Erreur lors de la récupération des emails: ${error.message}`,
      );
      throw error;
    } finally {
      this.imap.end();
    }
  }

  /**
   * Analyse le contenu des emails avec OpenAI
   */
  async analyzeEmails(emails: EmailContent[]): Promise<EmailContent[]> {
    this.logger.log(`Début de l'analyse de ${emails.length} emails`);

    const analyzedEmails = await Promise.all(
      emails.map(async (email) => {
        try {
          const analysisResult = await this.analyzeEmailContent(email);
          return {
            ...email,
            analysis: analysisResult,
          };
        } catch (error: any) {
          this.logger.error(
            `Erreur lors de l'analyse de l'email ${email.id}: ${error.message}`,
          );
          return email;
        }
      }),
    );

    this.logger.log(`Analyse terminée pour ${emails.length} emails`);
    return analyzedEmails;
  }

  /**
   * Analyse un email individuel avec OpenAI
   */
  private async analyzeEmailContent(email: EmailContent): Promise<{
    summary: string;
    priority: 'high' | 'medium' | 'low';
    category: string;
    actionRequired: boolean;
    actionItems?: string[];
  }> {
    this.logger.debug(`Analyse de l'email: ${email.subject}`);

    // Préparer le contenu pour l'analyse
    const prompt = `
    Analyser cet email et fournir les informations suivantes:
    
    Email de: ${email.from}
    À: ${email.to}
    Sujet: ${email.subject}
    Date: ${email.date}
    
    Contenu:
    ${email.body.substring(0, 1500)}
    
    Fournir:
    1. Un résumé concis (max 2 phrases)
    2. Niveau de priorité (high, medium, low)
    3. Catégorie (personnel, professionnel, marketing, facture, administratif, autre)
    4. Si une action est requise (true/false)
    5. Si une action est requise, liste des actions à prendre
    
    Réponse au format JSON strict avec les clés: summary, priority, category, actionRequired, actionItems (si applicable)
    `;

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content:
            "Tu es un assistant spécialisé dans l'analyse d'emails. Réponds uniquement au format JSON sans aucun autre texte.",
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
    });

    try {
      const content = response.choices[0].message.content;
      if (!content) {
        throw new Error('Aucune réponse générée par OpenAI');
      }

      // Extraire le JSON de la réponse
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      const jsonString = jsonMatch ? jsonMatch[0] : content;

      return JSON.parse(jsonString);
    } catch (error: any) {
      this.logger.error(
        `Erreur lors du parsing de la réponse OpenAI: ${error.message}`,
      );
      return {
        summary: "Impossible d'analyser cet email",
        priority: 'medium',
        category: 'autre',
        actionRequired: false,
      };
    }
  }

  /**
   * Génère un résumé général de tous les emails analysés
   */
  async generateOverallSummary(analyzedEmails: EmailContent[]): Promise<{
    summary: string;
    totalEmails: number;
    highPriorityCount: number;
    actionRequiredCount: number;
    categoryCounts: Record<string, number>;
    topPriorityEmails: EmailContent[];
    actionItems: string[];
  }> {
    if (analyzedEmails.length === 0) {
      return {
        summary: 'Aucun email à analyser',
        totalEmails: 0,
        highPriorityCount: 0,
        actionRequiredCount: 0,
        categoryCounts: {},
        topPriorityEmails: [],
        actionItems: [],
      };
    }

    // Statistiques de base
    const totalEmails = analyzedEmails.length;
    const highPriorityEmails = analyzedEmails.filter(
      (email) => email.analysis?.priority === 'high',
    );
    const actionRequiredEmails = analyzedEmails.filter(
      (email) => email.analysis?.actionRequired === true,
    );

    // Compter les emails par catégorie
    const categoryCounts: Record<string, number> = {};
    analyzedEmails.forEach((email) => {
      if (email.analysis?.category) {
        const category = email.analysis.category;
        categoryCounts[category] = (categoryCounts[category] || 0) + 1;
      }
    });

    // Extraire tous les éléments d'action
    const allActionItems: string[] = [];
    actionRequiredEmails.forEach((email) => {
      if (
        email.analysis?.actionItems &&
        email.analysis.actionItems.length > 0
      ) {
        allActionItems.push(
          ...email.analysis.actionItems.map(
            (item) => `${email.subject}: ${item}`,
          ),
        );
      }
    });

    // Générer un résumé global avec OpenAI
    const summaryPrompt = `
    Résumer cet ensemble de ${totalEmails} emails:
    
    ${analyzedEmails
      .map(
        (email) =>
          `- De: ${email.from}
       Sujet: ${email.subject}
       Priorité: ${email.analysis?.priority || 'non analysé'}
       Catégorie: ${email.analysis?.category || 'non catégorisé'}
       Résumé: ${email.analysis?.summary || 'non résumé'}`,
      )
      .join('\n\n')}
    
    Produire un résumé général concis (3-4 phrases maximum) qui donne un aperçu des principaux sujets, des priorités et des actions nécessaires.
    `;

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content:
              'Tu es un assistant qui résume efficacement les emails pour un professionnel occupé. Sois concis et direct.',
          },
          { role: 'user', content: summaryPrompt },
        ],
        temperature: 0.3,
      });

      const summary =
        response.choices[0].message.content ||
        'Impossible de générer un résumé';

      return {
        summary,
        totalEmails,
        highPriorityCount: highPriorityEmails.length,
        actionRequiredCount: actionRequiredEmails.length,
        categoryCounts,
        topPriorityEmails: highPriorityEmails.slice(0, 3), // Top 3 emails prioritaires
        actionItems: allActionItems.slice(0, 5), // Top 5 actions à effectuer
      };
    } catch (error: any) {
      this.logger.error(
        `Erreur lors de la génération du résumé global: ${error.message}`,
      );
      return {
        summary: 'Impossible de générer un résumé global des emails',
        totalEmails,
        highPriorityCount: highPriorityEmails.length,
        actionRequiredCount: actionRequiredEmails.length,
        categoryCounts,
        topPriorityEmails: highPriorityEmails.slice(0, 3),
        actionItems: allActionItems.slice(0, 5),
      };
    }
  }
}
