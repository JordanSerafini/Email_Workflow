import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Imap from 'node-imap';
import { simpleParser, ParsedMail } from 'mailparser';
import OpenAI from 'openai';

// Constantes pour le traitement par lots
const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 2000;

// Exporter l'interface pour qu'elle soit disponible dans le contrôleur
export interface EmailContent {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: Date;
  body: string;
  folderPath?: string; // Ajout du chemin du dossier où se trouve l'email
  imapUID?: string;    // Identifiant unique IMAP de l'email
  analysis?: {
    summary: string;
    priority: 'high' | 'medium' | 'low';
    category: string;
    actionRequired: boolean;
    actionItems?: string[];
    tokensUsed?: {
      input: number;
      output: number;
      total: number;
    };
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
  getBoxes(callback: (err: Error | null, boxes: any) => void): void;
}

// Ajout des interfaces pour le typage
interface ImapMessage {
  on(event: string, callback: (stream: NodeJS.ReadableStream) => void): void;
  once(event: 'end', callback: () => void): void;
  once(event: 'attributes', callback: (attrs: { uid?: number }) => void): void;
}

interface ImapFetch {
  on(event: string, callback: (msg: ImapMessage, seqno: number) => void): void;
  once(event: string, callback: () => void): void;
}

interface ParsedEmail {
  from?: { text: string };
  to?: { text: string };
  subject?: string;
  date?: Date;
  text?: string;
}

// Suppression des interfaces non utilisées
interface ImapError extends Error {
  message: string;
}

interface SearchError extends Error {
  message: string;
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

    const imapUser = this.configService.get<string>('EMAIL_USER') ?? '';
    const imapPassword = this.configService.get<string>('EMAIL_PASSWORD') ?? '';
    const imapHost = this.configService.get<string>('IMAP_HOST') ?? '';
    const imapPortConfig = this.configService.get<string>('IMAP_PORT');
    const imapPort = imapPortConfig ? parseInt(imapPortConfig, 10) : 993;

    const imapConfig: Imap.Config = {
      user: imapUser,
      password: imapPassword,
      host: imapHost,
      port: imapPort,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      debug: (info: string) => this.logger.debug(`IMAP Debug: ${info}`),
    };

    this.logger.log(
      `Configuration IMAP: ${imapHost}:${imapPort}, utilisateur: ${imapUser}`,
    );
    this.imap = new Imap(imapConfig) as TypedImap;
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

      this.imap.once('error', (err: ImapError) => {
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
   * Récupère la liste de tous les dossiers disponibles
   */
  private async getAllFolders(): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
      this.imap.getBoxes((err: Error | null, boxes: any) => {
        if (err) {
          this.logger.error(
            `Erreur lors de la récupération des dossiers: ${err.message}`,
          );
          return reject(
            new Error(
              `Erreur lors de la récupération des dossiers: ${err.message}`,
            ),
          );
        }

        // Extraire les noms de dossiers
        const folderNames = Object.keys(boxes);

        this.logger.log(`Dossiers trouvés: ${folderNames.join(', ')}`);
        resolve(folderNames);
      });
    });
  }

  /**
   * Récupère les emails non lus d'aujourd'hui de tous les dossiers
   */
  async getTodayEmails(): Promise<EmailContent[]> {
    try {
      await this.connectToImap();

      // Récupérer tous les dossiers disponibles
      const folders = await this.getAllFolders();
      this.logger.log(
        `Analyse de ${folders.length} dossiers pour les emails non lus d'aujourd'hui`,
      );

      const allEmails: EmailContent[] = [];

      // Parcourir chaque dossier
      for (const folder of folders) {
        try {
          this.logger.log(
            `Recherche des emails non lus dans le dossier: ${folder}`,
          );

          await new Promise<void>((resolve) => {
            this.imap.openBox(folder, true, (err: Error | null) => {
              if (err) {
                this.logger.warn(
                  `Impossible d'ouvrir le dossier ${folder}: ${err.message}`,
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
            `Recherche des emails non lus dans ${folder} pour la date: ${searchDate}`,
          );

          // Rechercher les emails non lus dans ce dossier
          const folderEmails = await new Promise<EmailContent[]>(
            (resolve, reject) => {
              this.imap.search(
                ['UNSEEN', ['SINCE', searchDate]],
                (searchErr: SearchError | null, results: number[]) => {
                  if (searchErr) {
                    this.logger.error(
                      `Erreur lors de la recherche des emails dans ${folder}: ${searchErr.message}`,
                    );
                    return reject(searchErr);
                  }

                  if (!results || results.length === 0) {
                    this.logger.log(`Aucun email non lu trouvé dans ${folder}`);
                    return resolve([]);
                  }

                  this.logger.log(
                    `${results.length} emails non lus trouvés dans ${folder}. Chargement du contenu...`,
                  );

                  const emailPromises: Promise<EmailContent>[] = [];
                  const fetch = this.imap.fetch(results, {
                    bodies: [''],
                    struct: true,
                    uid: true
                  }) as ImapFetch;

                  fetch.on('message', (msg: ImapMessage, seqno: number) => {
                    const emailPromise = new Promise<EmailContent>(
                      (resolveEmail, rejectEmail) => {
                        const email: Partial<EmailContent> = {
                          id: String(seqno),
                          folderPath: folder,
                        };
                        
                        // Capturer l'UID IMAP
                        msg.once('attributes', (attrs) => {
                          if (attrs && attrs.uid) {
                            email.imapUID = String(attrs.uid);
                          }
                        });

                        msg.on('body', (stream: NodeJS.ReadableStream) => {
                          let buffer = '';
                          stream.on('data', (chunk: Buffer) => {
                            buffer += chunk.toString('utf8');
                          });

                          stream.once('end', () => {
                            void (async () => {
                              try {
                                this.logger.debug(
                                  `Parsing du contenu de l'email #${seqno} dans ${folder}`,
                                );
                                const bufferContent: Buffer =
                                  Buffer.from(buffer);
                                const parsedEmail: ParsedMail =
                                  await simpleParser(bufferContent);
                                const parsed: ParsedEmail =
                                  parsedEmail as unknown as ParsedEmail;

                                email.from = parsed.from?.text || '';
                                email.to = parsed.to?.text || '';
                                email.subject = parsed.subject || '';
                                email.date = parsed.date || new Date();
                                email.body = parsed.text || '';

                                this.logger.debug(
                                  `Email #${seqno} parsé avec succès: ${email.subject}`,
                                );

                                resolveEmail(email as EmailContent);
                              } catch (e: unknown) {
                                const errorMessage =
                                  e instanceof Error
                                    ? e.message
                                    : 'Erreur inconnue';
                                this.logger.error(
                                  `Erreur lors du parsing de l'email #${seqno}: ${errorMessage}`,
                                );
                                rejectEmail(
                                  new Error(
                                    `Erreur lors du parsing de l'email #${seqno}: ${errorMessage}`,
                                  ),
                                );
                              }
                            })();
                          });
                        });
                      },
                    );

                    emailPromises.push(emailPromise);
                  });

                  fetch.once('end', () => {
                    Promise.all(emailPromises)
                      .then((emails) => resolve(emails))
                      .catch((error: Error) => reject(error));
                  });
                },
              );
            },
          );

          // Filtrer les emails par date (aujourd'hui uniquement)
          const todayEmails = folderEmails.filter((email) => {
            if (!email.date) return false;

            const emailDate = new Date(email.date);
            emailDate.setHours(0, 0, 0, 0); // Début de la journée

            const todayDate = new Date();
            todayDate.setHours(0, 0, 0, 0); // Début de la journée

            return emailDate.getTime() === todayDate.getTime();
          });

          // Ajouter les emails de ce dossier au tableau global
          allEmails.push(...todayEmails);
        } catch (folderError: unknown) {
          const errorMessage =
            folderError instanceof Error
              ? folderError.message
              : 'Erreur inconnue';
          this.logger.error(
            `Erreur lors du traitement du dossier ${folder}: ${errorMessage}`,
          );
          // Continuer avec le dossier suivant
        }
      }

      this.logger.log(
        `${allEmails.length} emails non lus récupérés au total de tous les dossiers`,
      );
      return allEmails;
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Erreur inconnue';
      this.logger.error(
        `Erreur lors de la récupération des emails: ${errorMessage}`,
      );
      throw error;
    } finally {
      this.imap.end();
    }
  }

  /**
   * Récupère tous les emails du jour (lus et non lus) de tous les dossiers
   */
  async getAllTodayEmails(): Promise<EmailContent[]> {
    try {
      await this.connectToImap();

      // Récupérer tous les dossiers disponibles
      const folders = await this.getAllFolders();
      this.logger.log(
        `Analyse de ${folders.length} dossiers pour tous les emails d'aujourd'hui`,
      );

      const allEmails: EmailContent[] = [];

      // Parcourir chaque dossier
      for (const folder of folders) {
        try {
          this.logger.log(
            `Recherche de tous les emails dans le dossier: ${folder}`,
          );

          await new Promise<void>((resolve, reject) => {
            this.imap.openBox(folder, true, (err: Error | null) => {
              if (err) {
                this.logger.warn(
                  `Impossible d'ouvrir le dossier ${folder}: ${err.message}`,
                );
                return resolve(); // Continuer avec le dossier suivant
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
            `Recherche de tous les emails dans ${folder} pour la date: ${searchDate}`,
          );

          // Rechercher tous les emails dans ce dossier
          const folderEmails = await new Promise<EmailContent[]>(
            (resolve, reject) => {
              this.imap.search(
                ['ALL', ['SINCE', searchDate]],
                (searchErr: SearchError | null, results: number[]) => {
                  if (searchErr) {
                    this.logger.error(
                      `Erreur lors de la recherche des emails dans ${folder}: ${searchErr.message}`,
                    );
                    return reject(searchErr);
                  }

                  if (!results || results.length === 0) {
                    this.logger.log(`Aucun email trouvé dans ${folder}`);
                    return resolve([]);
                  }

                  this.logger.log(
                    `${results.length} emails trouvés dans ${folder}. Chargement du contenu...`,
                  );

                  const emailPromises: Promise<EmailContent>[] = [];
                  const fetch = this.imap.fetch(results, {
                    bodies: [''],
                    struct: true,
                    uid: true
                  }) as ImapFetch;

                  fetch.on('message', (msg: ImapMessage, seqno: number) => {
                    const emailPromise = new Promise<EmailContent>(
                      (resolveEmail, rejectEmail) => {
                        const email: Partial<EmailContent> = {
                          id: String(seqno),
                          folderPath: folder,
                        };
                        
                        // Capturer l'UID IMAP
                        msg.once('attributes', (attrs) => {
                          if (attrs && attrs.uid) {
                            email.imapUID = String(attrs.uid);
                          }
                        });

                        msg.on('body', (stream: NodeJS.ReadableStream) => {
                          let buffer = '';
                          stream.on('data', (chunk: Buffer) => {
                            buffer += chunk.toString('utf8');
                          });

                          stream.once('end', () => {
                            void (async () => {
                              try {
                                this.logger.debug(
                                  `Parsing du contenu de l'email #${seqno} dans ${folder}`,
                                );
                                const bufferContent: Buffer =
                                  Buffer.from(buffer);
                                const parsedEmail: ParsedMail =
                                  await simpleParser(bufferContent);
                                const parsed: ParsedEmail =
                                  parsedEmail as unknown as ParsedEmail;

                                email.from = parsed.from?.text || '';
                                email.to = parsed.to?.text || '';
                                email.subject = parsed.subject || '';
                                email.date = parsed.date || new Date();
                                email.body = parsed.text || '';

                                this.logger.debug(
                                  `Email #${seqno} parsé avec succès: ${email.subject}`,
                                );

                                resolveEmail(email as EmailContent);
                              } catch (e: unknown) {
                                const errorMessage =
                                  e instanceof Error
                                    ? e.message
                                    : 'Erreur inconnue';
                                this.logger.error(
                                  `Erreur lors du parsing de l'email #${seqno}: ${errorMessage}`,
                                );
                                rejectEmail(
                                  new Error(
                                    `Erreur lors du parsing de l'email #${seqno}: ${errorMessage}`,
                                  ),
                                );
                              }
                            })();
                          });
                        });
                      },
                    );

                    emailPromises.push(emailPromise);
                  });

                  fetch.once('end', () => {
                    Promise.all(emailPromises)
                      .then((emails) => resolve(emails))
                      .catch((error: Error) => reject(error));
                  });
                },
              );
            },
          );

          // Filtrer les emails par date (aujourd'hui uniquement)
          const todayEmails = folderEmails.filter((email) => {
            if (!email.date) return false;

            const emailDate = new Date(email.date);
            emailDate.setHours(0, 0, 0, 0); // Début de la journée

            const todayDate = new Date();
            todayDate.setHours(0, 0, 0, 0); // Début de la journée

            return emailDate.getTime() === todayDate.getTime();
          });

          // Ajouter les emails de ce dossier au tableau global
          allEmails.push(...todayEmails);
        } catch (folderError: unknown) {
          const errorMessage =
            folderError instanceof Error
              ? folderError.message
              : 'Erreur inconnue';
          this.logger.error(
            `Erreur lors du traitement du dossier ${folder}: ${errorMessage}`,
          );
          // Continuer avec le dossier suivant
        }
      }

      this.logger.log(
        `${allEmails.length} emails récupérés au total de tous les dossiers`,
      );
      return allEmails;
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Erreur inconnue';
      this.logger.error(
        `Erreur lors de la récupération des emails: ${errorMessage}`,
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

    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    // Traiter les emails par lots pour éviter de surcharger l'API
    const analyzedEmails = await this.processEmailsInBatches(emails);

    // Calculer le total des tokens utilisés
    analyzedEmails.forEach((email) => {
      if (email.analysis?.tokensUsed) {
        totalInputTokens += email.analysis.tokensUsed.input;
        totalOutputTokens += email.analysis.tokensUsed.output;
      }
    });

    this.logger.log(
      `Analyse terminée pour ${emails.length} emails. Tokens utilisés: ${totalInputTokens} (entrée), ${totalOutputTokens} (sortie)`,
    );
    return analyzedEmails;
  }

  /**
   * Traite les emails par lots pour éviter de surcharger l'API OpenAI
   * @param emails Liste des emails à traiter
   */
  private async processEmailsInBatches(
    emails: EmailContent[],
  ): Promise<EmailContent[]> {
    this.logger.log(
      `Traitement des emails par lots: ${emails.length} emails au total, ${BATCH_SIZE} emails par lot`,
    );

    const analyzedEmails: EmailContent[] = [];

    // Diviser les emails en lots
    for (let i = 0; i < emails.length; i += BATCH_SIZE) {
      const batch = emails.slice(i, i + BATCH_SIZE);
      this.logger.log(
        `Traitement du lot ${i / BATCH_SIZE + 1}/${Math.ceil(emails.length / BATCH_SIZE)} (${batch.length} emails)`,
      );

      // Analyser le lot d'emails
      const batchResults = await Promise.all(
        batch.map(async (email) => {
          try {
            const analysisResult = await this.analyzeEmailContent(email);
            return {
              ...email,
              analysis: analysisResult,
            };
          } catch (error) {
            this.logger.error(
              `Erreur lors de l'analyse de l'email ${email.id}: ${error instanceof Error ? error.message : String(error)}`,
            );
            return email;
          }
        }),
      );

      // Ajouter les résultats du lot au tableau global
      analyzedEmails.push(...batchResults);

      // Si ce n'est pas le dernier lot, attendre avant de continuer
      if (i + BATCH_SIZE < emails.length) {
        this.logger.log(
          `Attente de ${BATCH_DELAY_MS / 1000} secondes avant le prochain lot...`,
        );
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }

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
    tokensUsed?: {
      input: number;
      output: number;
      total: number;
    };
  }> {
    this.logger.debug(`Analyse de l'email: ${email.subject}`);

    // Préparer le contenu pour l'analyse
    const prompt = `
    Analyser cet email et fournir les informations suivantes:
    
    Email de: ${email.from}
    À: ${email.to}
    Sujet: ${email.subject}
    Date: ${email.date.toISOString()}
    
    Contenu:
    ${email.body.substring(0, 1500)}
    
    Fournir:
    1. Un résumé concis (max 2 phrases)
    2. Niveau de priorité (high, medium, low)
    3. Catégorie (personnel, professionnel, marketing, facture, administratif, autre)
    4. Si une action est requise (true/false)
    5. Si une action est requise, liste des actions à prendre
    
    IMPORTANT pour les actions à prendre:
    - Les actions doivent être directement liées au contenu spécifique de l'email
    - Pour les confirmations de rendez-vous/réunions: suggérer "Confirmer le rendez-vous" ou "Ajouter à l'agenda" 
    - Éviter les actions génériques qui ne découlent pas directement du contenu de l'email
    - Si l'email nécessite une réponse, ajouter l'action "Répondre à cet email"
    - Suggérer "Répondre à cet email" si pertinent
    
    Réponse au format JSON strict avec les clés: summary, priority, category, actionRequired, actionItems (si applicable)
    `;

    const response = await this.openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content:
            "Tu es un assistant spécialisé dans l'analyse d'emails. Réponds uniquement au format JSON sans aucun autre texte ni délimiteur markdown.",
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
    });

    // Extraire les informations sur les tokens
    const tokensUsed = {
      input: response.usage?.prompt_tokens || 0,
      output: response.usage?.completion_tokens || 0,
      total: response.usage?.total_tokens || 0,
    };

    this.logger.debug(
      `Tokens utilisés pour l'analyse: ${tokensUsed.total} (entrée: ${tokensUsed.input}, sortie: ${tokensUsed.output})`,
    );

    try {
      const content = response.choices[0].message.content;
      if (!content) {
        throw new Error('Aucune réponse générée par OpenAI');
      }

      // Extraire le JSON de la réponse
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      const jsonString = jsonMatch ? jsonMatch[0] : content;

      const parsedResult = JSON.parse(jsonString) as {
        summary: string;
        priority: 'high' | 'medium' | 'low';
        category: string;
        actionRequired: boolean;
        actionItems?: string[];
      };

      // Ajouter les informations sur les tokens utilisés
      return {
        ...parsedResult,
        tokensUsed,
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Erreur inconnue';
      this.logger.error(
        `Erreur lors du parsing de la réponse OpenAI: ${errorMessage}`,
      );
      return {
        summary: "Impossible d'analyser cet email",
        priority: 'medium',
        category: 'autre',
        actionRequired: false,
        tokensUsed,
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
    tokensUsed?: {
      input: number;
      output: number;
      total: number;
    };
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
        tokensUsed: {
          input: 0,
          output: 0,
          total: 0,
        },
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

    // Obtenir la date du jour au format JJ/MM/AAAA
    const today = new Date();
    const day = today.getDate().toString().padStart(2, '0');
    const month = (today.getMonth() + 1).toString().padStart(2, '0');
    const year = today.getFullYear();
    const formattedDate = `${day}/${month}/${year}`;

    const summaryPrompt = `
    Analyser et résumer cet ensemble de ${totalEmails} emails:
    
    ${analyzedEmails
      .map(
        (email) =>
          `- De: ${email.from}
       Sujet: ${email.subject}
       Priorité: ${email.analysis?.priority || 'non analysé'}
       Catégorie: ${email.analysis?.category || 'non catégorisé'}
       Résumé: ${email.analysis?.summary || 'non résumé'}
       Dossier: ${email.folderPath || 'non spécifié'}
       Actions requises: ${email.analysis?.actionItems ? email.analysis.actionItems.join(', ') : 'aucune'}`,
      )
      .join('\n\n')}
    
    Générer un résumé conversationnel comme si tu parlais directement à l'utilisateur.
    
    Instructions détaillées:
    1. Commencer par "Bonjour, voici votre résumé d'emails du [date]"
    2. Indiquer le nombre total d'emails analysés, combien sont prioritaires et combien requièrent une action
    3. Présenter les emails les plus importants de façon conversationnelle, en regroupant ceux qui concernent le même sujet
    4. Lister les actions principales recommandées (maximum 5) de façon naturelle
    5. Mentionner brièvement les autres informations notables ou répartition par catégories
    
    Ton doit être:
    - Chaleureux mais professionnel
    - Direct et informatif
    - Personnel (utiliser "votre", "vous", "vos")
    - Conversationnel plutôt que structuré avec des titres
    `;

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content:
              "Tu es un assistant personnel qui présente un résumé d'emails de façon conversationnelle et naturelle. Tu t'adresses directement à l'utilisateur comme si tu étais en train de lui parler.",
          },
          { role: 'user', content: summaryPrompt },
        ],
        temperature: 0.5,
      });

      // Extraire les informations sur les tokens
      const tokensUsed = {
        input: response.usage?.prompt_tokens || 0,
        output: response.usage?.completion_tokens || 0,
        total: response.usage?.total_tokens || 0,
      };

      this.logger.debug(
        `Tokens utilisés pour le résumé global: ${tokensUsed.total} (entrée: ${tokensUsed.input}, sortie: ${tokensUsed.output})`,
      );

      const summary =
        response.choices[0].message.content ||
        'Impossible de générer un résumé';

      // Remplacer le placeholder [date] par la date réelle formatée
      const formattedSummary = summary.replace('[date]', formattedDate);

      return {
        summary: formattedSummary,
        totalEmails,
        highPriorityCount: highPriorityEmails.length,
        actionRequiredCount: actionRequiredEmails.length,
        categoryCounts,
        topPriorityEmails: highPriorityEmails.slice(0, 3), // Top 3 emails prioritaires
        actionItems: allActionItems.slice(0, 5), // Top 5 actions à effectuer
        tokensUsed,
      };
    } catch (error: unknown) {
      this.logger.error(
        `Erreur lors de la génération du résumé global: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        summary: 'Impossible de générer un résumé global des emails',
        totalEmails,
        highPriorityCount: highPriorityEmails.length,
        actionRequiredCount: actionRequiredEmails.length,
        categoryCounts,
        topPriorityEmails: highPriorityEmails.slice(0, 3),
        actionItems: allActionItems.slice(0, 5),
        tokensUsed: {
          input: 0,
          output: 0,
          total: 0,
        },
      };
    }
  }

  /**
   * Génère un brouillon de réponse pour un email donné
   * @param email Email pour lequel générer une réponse
   */
  async generateEmailResponse(email: EmailContent): Promise<{
    response: string;
    tokensUsed: {
      input: number;
      output: number;
      total: number;
    };
  }> {
    this.logger.debug(
      `Génération d'une réponse pour l'email: ${email.subject}`,
    );

    // Préparer le contenu pour la génération de réponse
    const prompt = `
    Tu dois rédiger une réponse professionnelle à l'email suivant:
    
    De: ${email.from}
    À: ${email.to}
    Sujet: ${email.subject}
    Date: ${email.date.toISOString()}
    
    Contenu de l'email:
    ${email.body.substring(0, 1500)}
    
    Instructions pour la réponse:
    - Garder un ton professionnel et courtois
    - Répondre directement aux questions ou demandes
    - Être concis mais complet
    - Si l'email concerne une réunion ou un rendez-vous, confirmer la disponibilité
    - Si l'email concerne une demande d'information, fournir des réponses précises ou demander plus de détails si nécessaire
    - Terminer par une formule de politesse appropriée
    
    Rédige uniquement le corps de l'email, sans objet ni formule d'introduction comme "Voici ma réponse:".
    `;

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content:
              "Tu es un assistant professionnel expert en rédaction d'emails. Tu réponds de manière concise, claire et adaptée au contexte professionnel.",
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.7,
      });

      // Extraire les informations sur les tokens
      const tokensUsed = {
        input: response.usage?.prompt_tokens || 0,
        output: response.usage?.completion_tokens || 0,
        total: response.usage?.total_tokens || 0,
      };

      this.logger.debug(
        `Tokens utilisés pour la génération de réponse: ${tokensUsed.total} (entrée: ${tokensUsed.input}, sortie: ${tokensUsed.output})`,
      );

      const draftResponse =
        response.choices[0].message.content ||
        'Impossible de générer une réponse.';
      return {
        response: draftResponse,
        tokensUsed,
      };
    } catch (error: unknown) {
      this.logger.error(
        `Erreur lors de la génération de la réponse à l'email: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        response:
          'Impossible de générer une réponse à cet email. Veuillez essayer ultérieurement.',
        tokensUsed: {
          input: 0,
          output: 0,
          total: 0,
        },
      };
    }
  }

  /**
   * Reformule ou améliore un brouillon de réponse à un email
   * @param email Email original
   * @param draftResponse Brouillon de réponse à améliorer
   * @param instructions Instructions spécifiques pour la reformulation
   */
  async rewriteEmailResponse(
    email: EmailContent,
    draftResponse: string,
    instructions: string,
  ): Promise<{
    response: string;
    tokensUsed: {
      input: number;
      output: number;
      total: number;
    };
  }> {
    this.logger.debug(
      `Reformulation de la réponse pour l'email: ${email.subject}`,
    );

    // Préparer le contenu pour la reformulation
    const prompt = `
    Tu dois reformuler ou améliorer cette réponse à un email selon les instructions spécifiques.
    
    Email original:
    De: ${email.from}
    À: ${email.to}
    Sujet: ${email.subject}
    
    Contenu de l'email original:
    ${email.body.substring(0, 500)}
    
    Brouillon de réponse actuel:
    ${draftResponse}
    
    Instructions pour la reformulation:
    ${instructions}
    
    Fournir uniquement la version reformulée de la réponse, sans commentaires additionnels.
    `;

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content:
              "Tu es un rédacteur professionnel expert en communication par email. Tu améliores les réponses en respectant les instructions spécifiques tout en conservant le message d'origine.",
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.7,
      });

      // Extraire les informations sur les tokens
      const tokensUsed = {
        input: response.usage?.prompt_tokens || 0,
        output: response.usage?.completion_tokens || 0,
        total: response.usage?.total_tokens || 0,
      };

      this.logger.debug(
        `Tokens utilisés pour la reformulation: ${tokensUsed.total} (entrée: ${tokensUsed.input}, sortie: ${tokensUsed.output})`,
      );

      const rewrittenResponse =
        response.choices[0].message.content ||
        'Impossible de reformuler la réponse.';
      return {
        response: rewrittenResponse,
        tokensUsed,
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Erreur inconnue';
      this.logger.error(
        `Erreur lors de la reformulation de la réponse: ${errorMessage}`,
      );
      return {
        response:
          'Impossible de reformuler la réponse. Veuillez essayer ultérieurement.',
        tokensUsed: {
          input: 0,
          output: 0,
          total: 0,
        },
      };
    }
  }

  /**
   * Formate le résumé en un format professionnel structuré
   * @param summaryData Données du résumé à formater
   */
  async formatProfessionalSummary(summaryData: {
    summary: string;
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
  }): Promise<{
    formattedSummary: string;
    tokensUsed: {
      input: number;
      output: number;
      total: number;
    };
  }> {
    try {
      // Ajout d'une opération asynchrone pour satisfaire le linter
      await Promise.resolve();

      // Récupérer les tokens utilisés pour la génération du résumé initial
      const initialTokensUsed = summaryData.tokensUsed || {
        input: 0,
        output: 0,
        total: 0,
      };

      // Obtenir la date du jour au format français
      const today = new Date();
      const options: Intl.DateTimeFormatOptions = {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      };
      const dateStr = today.toLocaleDateString('fr-FR', options);

      // Créer un résumé conversationnel
      let formattedSummary = `Bonjour, voici votre résumé d'emails du ${dateStr}.\n\n`;

      // Aperçu du nombre d'emails
      formattedSummary += `J'ai analysé ${summaryData.totalEmails} emails aujourd'hui`;
      
      if (summaryData.highPriorityCount > 0) {
        formattedSummary += `, dont ${summaryData.highPriorityCount} nécessitent votre attention prioritaire`;
      }
      
      if (summaryData.actionRequiredCount > 0) {
        formattedSummary += ` et ${summaryData.actionRequiredCount} requièrent une action de votre part`;
      }
      formattedSummary += `.\n\n`;

      // Emails prioritaires
      if (summaryData.topPriorityEmails && summaryData.topPriorityEmails.length > 0) {
        formattedSummary += `Les emails les plus importants concernent `;
        
        const emailSubjects = summaryData.topPriorityEmails.map(email => 
          `"${email.subject}" de ${email.from.split('<')[0].replace(/"/g, '')}`
        );
        
        if (emailSubjects.length === 1) {
          formattedSummary += `${emailSubjects[0]}`;
        } else if (emailSubjects.length === 2) {
          formattedSummary += `${emailSubjects[0]} et ${emailSubjects[1]}`;
        } else {
          const lastSubject = emailSubjects.pop();
          formattedSummary += `${emailSubjects.join(', ')} et ${lastSubject}`;
        }
        formattedSummary += `.\n\n`;
      }

      // Actions requises
      if (summaryData.actionItems && summaryData.actionItems.length > 0) {
        const uniqueActions = [...new Set(summaryData.actionItems)];
        if (uniqueActions.length === 1) {
          formattedSummary += `L'action principale à effectuer est de ${uniqueActions[0].toLowerCase()}.\n\n`;
        } else if (uniqueActions.length > 1) {
          formattedSummary += `Voici les actions principales à effectuer :\n`;
          uniqueActions.slice(0, 5).forEach((action, index) => {
            formattedSummary += `${index + 1}. ${action}\n`;
          });
          if (uniqueActions.length > 5) {
            formattedSummary += `... et ${uniqueActions.length - 5} autres actions.\n`;
          }
          formattedSummary += `\n`;
        }
      }

      // Résumé des catégories d'emails
      if (summaryData.categoryCounts && Object.keys(summaryData.categoryCounts).length > 0) {
        formattedSummary += `Vos emails se répartissent principalement entre `;
        
        const categories = Object.entries(summaryData.categoryCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([category, count]) => `${count} emails ${category}s`);
        
        if (categories.length === 1) {
          formattedSummary += `${categories[0]}`;
        } else if (categories.length === 2) {
          formattedSummary += `${categories[0]} et ${categories[1]}`;
        } else {
          const lastCategory = categories.pop();
          formattedSummary += `${categories.join(', ')} et ${lastCategory}`;
        }
        formattedSummary += `.\n\n`;
      }

      // Résumé général
      formattedSummary += `En résumé : ${summaryData.summary}\n\n`;

      return {
        formattedSummary,
        tokensUsed: initialTokensUsed,
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Erreur inconnue';
      this.logger.error(
        `Erreur lors du formatage professionnel du résumé: ${errorMessage}`,
      );
      return {
        formattedSummary: 'Impossible de générer le résumé conversationnel de vos emails.',
        tokensUsed: {
          input: 0,
          output: 0,
          total: 0,
        },
      };
    }
  }
}
