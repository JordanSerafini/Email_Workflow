import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Imap from 'node-imap';
import { simpleParser } from 'mailparser';
import OpenAI from 'openai';

// Constantes pour le traitement par lots
const BATCH_SIZE = 5; // Nombre d'emails à traiter par lot
const BATCH_DELAY_MS = 2000; // Délai entre les lots en millisecondes

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
        this.imap.search(['UNSEEN'], (searchErr: any, results: any[]) => {
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
            `${results.length} emails non lus trouvés. Chargement du contenu...`,
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
        });
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
   * Récupère tous les emails du jour (lus et non lus)
   * @param mailboxName Nom de la boîte aux lettres à analyser (par défaut: 'INBOX')
   */
  async getAllTodayEmails(
    mailboxName: string = 'INBOX',
  ): Promise<EmailContent[]> {
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
      today.setHours(0, 0, 0, 0); // Début de la journée

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
        `Recherche de tous les emails dans ${mailboxName} pour la date: ${searchDate}`,
      );

      const emails = await new Promise<EmailContent[]>((resolve, reject) => {
        this.imap.search(['ALL'], (searchErr: any, results: any[]) => {
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
            this.logger.log("Aucun email trouvé pour aujourd'hui");
            return resolve([]);
          }

          this.logger.log(
            `${results.length} emails trouvés. Chargement du contenu...`,
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
              .then((allEmails) => {
                // Filtrer les emails par date (aujourd'hui uniquement)
                const todayEmails = allEmails.filter((email) => {
                  if (!email.date) return false;

                  const emailDate = new Date(email.date);
                  emailDate.setHours(0, 0, 0, 0); // Début de la journée

                  const todayDate = new Date();
                  todayDate.setHours(0, 0, 0, 0); // Début de la journée

                  return emailDate.getTime() === todayDate.getTime();
                });

                this.logger.log(
                  `Récupération terminée. Filtrage: ${allEmails.length} emails récupérés, ${todayEmails.length} emails d'aujourd'hui.`,
                );
                resolve(todayEmails);
              })
              .catch((error) => reject(error));
          });
        });
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
      model: 'gpt-4o',
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

      const parsedResult = JSON.parse(jsonString);

      // Ajouter les informations sur les tokens utilisés
      return {
        ...parsedResult,
        tokensUsed,
      };
    } catch (error: any) {
      this.logger.error(
        `Erreur lors du parsing de la réponse OpenAI: ${error.message}`,
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

      return {
        summary,
        totalEmails,
        highPriorityCount: highPriorityEmails.length,
        actionRequiredCount: actionRequiredEmails.length,
        categoryCounts,
        topPriorityEmails: highPriorityEmails.slice(0, 3), // Top 3 emails prioritaires
        actionItems: allActionItems.slice(0, 5), // Top 5 actions à effectuer
        tokensUsed,
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
        model: 'gpt-4o',
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
    } catch (error: any) {
      this.logger.error(
        `Erreur lors de la génération de la réponse à l'email: ${error.message}`,
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
        model: 'gpt-4o',
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
    } catch (error: any) {
      this.logger.error(
        `Erreur lors de la reformulation de la réponse: ${error.message}`,
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
      // Récupérer les tokens utilisés pour la génération du résumé initial
      const initialTokensUsed = summaryData.tokensUsed || {
        input: 0,
        output: 0,
        total: 0,
      };

      // Structurer le résumé pour une présentation professionnelle
      let formattedSummary = `📋 RÉSUMÉ PROFESSIONNEL\n\n`;

      // Statistiques globales
      formattedSummary += `🔍 Aperçu général:\n`;
      formattedSummary += `• Total emails: ${summaryData.totalEmails}\n`;
      formattedSummary += `• Emails haute priorité: ${summaryData.highPriorityCount}\n`;
      formattedSummary += `• Actions requises: ${summaryData.actionRequiredCount}\n\n`;

      // Répartition par catégories professionnelles
      formattedSummary += `📊 Répartition par catégories:\n`;
      if (summaryData.categoryCounts) {
        // Afficher les catégories professionnelles prioritaires
        if (summaryData.categoryCounts.professionnel)
          formattedSummary += `• Professionnels: ${summaryData.categoryCounts.professionnel}\n`;

        if (summaryData.categoryCounts.facture)
          formattedSummary += `• Factures: ${summaryData.categoryCounts.facture}\n`;

        if (summaryData.categoryCounts.marketing)
          formattedSummary += `• Marketing: ${summaryData.categoryCounts.marketing}\n`;

        // Autres catégories
        Object.entries(summaryData.categoryCounts)
          .filter(
            ([key]) =>
              !['professionnel', 'facture', 'marketing', 'personnel'].includes(
                key,
              ),
          )
          .forEach(([key, count]) => {
            formattedSummary += `• ${key.charAt(0).toUpperCase() + key.slice(1)}: ${count}\n`;
          });
      }

      // Actions à entreprendre
      if (summaryData.actionItems && summaryData.actionItems.length > 0) {
        formattedSummary += `\n⚡ Actions requises:\n`;

        // Regrouper les tâches par catégorie professionnelle
        const professionalTasks = summaryData.actionItems.filter(
          (item) =>
            !item.toLowerCase().includes('facebook') &&
            !item.toLowerCase().includes('personnel'),
        );

        professionalTasks.forEach((item, index) => {
          formattedSummary += `${index + 1}. ${item}\n`;
        });
      }

      // Emails haute priorité professionnels
      if (
        summaryData.topPriorityEmails &&
        summaryData.topPriorityEmails.length > 0
      ) {
        const professionalHighPriority = summaryData.topPriorityEmails.filter(
          (email) =>
            email.analysis?.category === 'professionnel' ||
            email.analysis?.category === 'facture',
        );

        if (professionalHighPriority.length > 0) {
          formattedSummary += `\n🔴 Emails professionnels prioritaires:\n`;
          professionalHighPriority.forEach((email) => {
            formattedSummary += `• ${email.subject} - ${email.analysis?.summary}\n`;
          });
        }
      }

      // Résumé général
      formattedSummary += `\n📝 Résumé général:\n${summaryData.summary}`;

      // Informations sur les tokens utilisés pour les analyses
      formattedSummary += `\n\n🔄 Statistiques d'utilisation API:\n`;
      formattedSummary += `• Tokens entrée: ${initialTokensUsed.input}\n`;
      formattedSummary += `• Tokens sortie: ${initialTokensUsed.output}\n`;
      formattedSummary += `• Tokens total: ${initialTokensUsed.total}\n`;

      return {
        formattedSummary,
        tokensUsed: initialTokensUsed,
      };
    } catch (error) {
      this.logger.error(
        `Erreur lors du formatage professionnel du résumé: ${error.message}`,
      );
      return {
        formattedSummary: 'Impossible de générer le résumé professionnel',
        tokensUsed: {
          input: 0,
          output: 0,
          total: 0,
        },
      };
    }
  }
}
