import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Imap from 'node-imap';
import { simpleParser } from 'mailparser';
import OpenAI from 'openai';
import { Readable } from 'stream';
import { Email } from './models/email.model';
import { AnalyzedInvoice, InvoiceData } from './models/invoice.model';
import { promisify } from 'util';

// Type pour l'instance IMAP
interface TypedImap {
  state?: string;
  once(event: string, callback: (...args: any[]) => void): void;
  on(event: string, callback: (...args: any[]) => void): void;
  connect(): void;
  getBoxes(
    callback: (err: Error | null, boxes: Record<string, any>) => void,
  ): void;
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
  setFlags(
    source: any,
    flags: string[],
    callback: (err: Error | null) => void,
  ): void;
  copy(
    source: any,
    destination: string,
    callback: (err: Error | null) => void,
  ): void;
  addFlags(
    source: any,
    flags: string[],
    callback: (err: Error | null) => void,
  ): void;
  expunge(callback: (err: Error | null) => void): void;
  addBox(name: string, callback: (err: Error | null) => void): void;
  end(): void;
}

@Injectable()
export class SortEmailService implements OnModuleInit {
  private readonly logger = new Logger(SortEmailService.name);
  private imap: TypedImap;
  private openai: OpenAI;
  private categories: string[];

  constructor(private configService: ConfigService) {
    this.openai = new OpenAI({
      apiKey: this.configService.get<string>('OPENAI_API_KEY'),
    });

    // On commence avec une liste vide, qui sera remplie par onModuleInit
    this.categories = [];

    // Configuration IMAP
    const imapConfig = {
      user: this.configService.get<string>('EMAIL_USER') || '',
      password: this.configService.get<string>('EMAIL_PASSWORD') || '',
      host: this.configService.get<string>('IMAP_HOST') || '',
      port: parseInt(this.configService.get<string>('IMAP_PORT') || '993', 10),
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 60000, // 60 secondes au lieu de 10
      authTimeout: 60000, // 60 secondes pour l'authentification
      debug: (info: any) => this.logger.debug(`IMAP Debug: ${info}`),
    };

    this.logger.log(
      `Configuration IMAP: ${imapConfig.host}:${imapConfig.port}, utilisateur: ${imapConfig.user}`,
    );
    this.imap = new Imap(imapConfig) as unknown as TypedImap;
  }

  async onModuleInit() {
    try {
      this.logger.log('Initialisation du service de tri des emails...');
      await this.connectToImap();
      this.logger.log('Connexion IMAP établie avec succès');

      // Récupérer les dossiers et les définir comme catégories
      await this.initializeCategories();

      // Liste les boîtes aux lettres disponibles
      await this.listMailboxes();
    } catch (error: any) {
      this.logger.error(
        `Échec de connexion au serveur de messagerie: ${error.message}`,
      );
    }
  }

  /**
   * Établit la connexion IMAP
   */
  async connectToImap(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.imap.once('ready', () => {
        this.logger.log('Connexion IMAP établie avec succès');
        resolve();
      });

      this.imap.once('error', (err: any) => {
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
   * Liste les boîtes aux lettres disponibles
   */
  async listMailboxes(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.imap.getBoxes((err, boxes) => {
        if (err) {
          this.logger.error(
            `Erreur lors de la récupération des boîtes: ${err.message}`,
          );
          return reject(
            new Error(
              `Erreur lors de la récupération des boîtes: ${err.message}`,
            ),
          );
        }

        this.logger.log('Boîtes aux lettres disponibles:');
        Object.keys(boxes).forEach((box) => {
          this.logger.log(`- ${box}`);
        });

        resolve();
      });
    });
  }

  /**
   * Récupère les emails non lus
   */
  async getUnsortedEmails(limit?: number): Promise<Email[]> {
    try {
      await this.connectToImap();

      await new Promise<void>((resolve, reject) => {
        this.imap.openBox('INBOX', false, (err: any) => {
          if (err) {
            this.logger.error(
              `Erreur lors de l'ouverture de la boîte: ${err.message}`,
            );
            return reject(
              new Error(
                `Erreur lors de l'ouverture de la boîte: ${err.message}`,
              ),
            );
          }
          resolve();
        });
      });

      this.logger.log('Recherche des emails non lus (UNSEEN)...');

      const emails = await new Promise<Email[]>((resolve, reject) => {
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
            this.logger.log('Aucun email non lu trouvé');
            return resolve([]);
          }

          this.logger.log(
            `${results.length} emails non lus trouvés. Chargement du contenu...`,
          );

          const finalResults = limit ? results.slice(0, limit) : results;
          this.logger.log(
            `Traitement de ${finalResults.length} emails (limite: ${limit})`,
          );

          const emailPromises: Promise<Email>[] = [];
          const fetch = this.imap.fetch(finalResults, {
            bodies: [''],
            struct: true,
            markSeen: false,
          });

          fetch.on('message', (msg: any, seqno: number) => {
            // Créer une promesse pour chaque email
            const emailPromise = new Promise<Email>(
              (resolveEmail, rejectEmail) => {
                const email: Partial<Email> = { id: String(seqno) };

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

                      // Résoudre la promesse avec l'email complet
                      resolveEmail(email as Email);
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

                msg.once('attributes', (attrs: any) => {
                  (email as any).uid = attrs.uid;
                });
              },
            );

            // Ajouter la promesse au tableau
            emailPromises.push(emailPromise);
          });

          fetch.once('error', (fetchErr: any) => {
            this.logger.error(
              `Erreur lors du fetch des emails: ${fetchErr.message}`,
            );
            reject(
              new Error(`Erreur lors du fetch des emails: ${fetchErr.message}`),
            );
          });

          fetch.once('end', () => {
            // Attendre que toutes les promesses d'emails soient résolues
            Promise.all(emailPromises)
              .then((resolvedEmails) => {
                this.logger.log(
                  `Récupération terminée. ${resolvedEmails.length} emails chargés.`,
                );
                resolve(resolvedEmails);
              })
              .catch((err: any) => {
                this.logger.error(
                  `Erreur lors du traitement des emails: ${err.message}`,
                );
                reject(
                  new Error(
                    `Erreur lors du traitement des emails: ${err.message}`,
                  ),
                );
              });
          });
        });
      });

      return emails;
    } catch (error: any) {
      this.logger.error(`Erreur dans getUnsortedEmails: ${error.message}`);
      throw error;
    }
  }

  /**
   * Récupère tous les emails
   */
  async getAllEmails(limit?: number): Promise<Email[]> {
    try {
      await this.connectToImap();

      await new Promise<void>((resolve, reject) => {
        this.imap.openBox('INBOX', false, (err) => {
          if (err) {
            this.logger.error(
              `Erreur lors de l'ouverture de la boîte: ${err.message}`,
            );
            return reject(err);
          }
          resolve();
        });
      });

      this.logger.log('Recherche de tous les emails...');

      const emails = await new Promise<Email[]>((resolve, reject) => {
        this.imap.search(['ALL'], (searchErr, results) => {
          if (searchErr) {
            this.logger.error(
              `Erreur lors de la recherche des emails: ${searchErr.message}`,
            );
            return reject(searchErr);
          }

          if (!results || results.length === 0) {
            this.logger.log('Aucun email trouvé');
            return resolve([]);
          }

          this.logger.log(
            `${results.length} emails trouvés. Chargement du contenu...`,
          );

          const finalResults = limit ? results.slice(0, limit) : results;
          this.logger.log(
            `Traitement de ${finalResults.length} emails (limite: ${limit})`,
          );

          const emailPromises: Promise<Email>[] = [];
          const fetch = this.imap.fetch(finalResults, {
            bodies: [''],
            struct: true,
            markSeen: false,
          });

          fetch.on('message', (msg, seqno) => {
            // Créer une promesse pour chaque email
            const emailPromise = new Promise<Email>(
              (resolveEmail, rejectEmail) => {
                const email: Partial<Email> = { id: String(seqno) };

                msg.on('body', (stream) => {
                  let buffer = '';
                  stream.on('data', (chunk) => {
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

                      // Résoudre la promesse avec l'email complet
                      resolveEmail(email as Email);
                    } catch (e) {
                      this.logger.error(
                        `Erreur lors du parsing de l'email #${seqno}: ${e.message}`,
                      );
                      rejectEmail(e);
                    }
                  });
                });

                msg.once('attributes', (attrs) => {
                  (email as any).uid = attrs.uid;
                });
              },
            );

            // Ajouter la promesse au tableau
            emailPromises.push(emailPromise);
          });

          fetch.once('error', (fetchErr) => {
            this.logger.error(
              `Erreur lors du fetch des emails: ${fetchErr.message}`,
            );
            reject(fetchErr);
          });

          fetch.once('end', () => {
            // Attendre que toutes les promesses d'emails soient résolues
            Promise.all(emailPromises)
              .then((resolvedEmails) => {
                this.logger.log(
                  `Récupération terminée. ${resolvedEmails.length} emails chargés.`,
                );
                resolve(resolvedEmails);
              })
              .catch((err) => {
                this.logger.error(
                  `Erreur lors du traitement des emails: ${err.message}`,
                );
                reject(err);
              });
          });
        });
      });

      return emails;
    } catch (error) {
      this.logger.error(`Erreur dans getAllEmails: ${error.message}`);
      throw error;
    }
  }

  /**
   * Ferme la connexion IMAP
   */
  private closeConnection() {
    try {
      if (this.imap && this.imap.state !== 'disconnected') {
        this.imap.end();
        this.logger.debug('Connexion IMAP fermée');
      }
    } catch (error) {
      this.logger.error(
        `Erreur lors de la fermeture de la connexion: ${error.message}`,
      );
    }
  }

  /**
   * Categorise un email en utilisant l'API OpenAI
   */
  async categorizeEmail(email: Email): Promise<string> {
    try {
      this.logger.log(
        `Catégorisation de l'email: "${email.subject?.substring(0, 50)}..."`,
      );

      const prompt = `
        Analyse l'email suivant et classe-le dans l'une des catégories suivantes: ${this.categories.join(', ')}.
        
        De: ${email.from}
        À: ${email.to}
        Sujet: ${email.subject}
        Date: ${email.date.toISOString()}
        Contenu: ${email.body.substring(0, 1000)}
        
        Réponds uniquement avec le nom de la catégorie la plus appropriée.
      `;

      this.logger.debug('Envoi de la requête à OpenAI pour classification...');
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

      this.logger.log(`Email classé dans la catégorie: ${validCategory}`);
      return validCategory;
    } catch (error) {
      this.logger.error(`Erreur lors de la catégorisation: ${error.message}`);
      this.logger.log('Classification par défaut: "Autre"');
      return 'Autre';
    }
  }

  /**
   * Tri les emails en utilisant l'API OpenAI
   */
  async sortEmails(limit?: number): Promise<{ [category: string]: Email[] }> {
    try {
      this.logger.log('Démarrage du processus de tri des emails...');
      const emails = await this.getUnsortedEmails(limit);
      this.logger.log(`Nombre total d'emails à trier: ${emails.length}`);

      // Afficher les UIDs des emails récupérés pour le débogage
      this.logger.debug(`UIDs des emails récupérés: ${emails.map(e => (e as any).uid).join(', ')}`);

      const sortedEmails: { [category: string]: Email[] } = {};

      // Initialiser les catégories
      this.categories.forEach((category) => {
        sortedEmails[category] = [];
      });

      // Trier chaque email
      this.logger.log('Classification des emails par catégorie...');
      for (const email of emails) {
        this.logger.log(
          `Traitement de l'email: "${email.subject?.substring(0, 30)}..."`,
        );
        const category = await this.categorizeEmail(email);
        email.category = category;
        sortedEmails[category].push(email);
        this.logger.debug(`Email ajouté à la catégorie: ${category}`);
      }

      // Résumé des résultats de tri
      this.logger.log('Tri des emails terminé. Résumé par catégorie:');
      for (const category of Object.keys(sortedEmails)) {
        const count = sortedEmails[category].length;
        if (count > 0) {
          this.logger.log(`- ${category}: ${count} email(s)`);
          
          // Afficher les UIDs par catégorie pour le débogage
          this.logger.debug(
            `UIDs des emails dans la catégorie "${category}": ${sortedEmails[category]
              .map(e => (e as any).uid)
              .join(', ')}`
          );
        }
      }

      // Ne pas fermer la connexion ici
      return sortedEmails;
    } catch (error) {
      this.closeConnection();
      this.logger.error(`Erreur pendant le tri des emails: ${error.message}`);
      throw error;
    }
  }

  /**
   * Déplace les emails vers les dossiers de catégories appropriés
   */
  async processSortedEmails(sortedEmails: {
    [category: string]: Email[];
  }): Promise<void> {
    try {
      this.logger.log('Début du traitement des emails triés...');

      // S'assurer que la connexion IMAP est active
      try {
        if (!this.imap.state || this.imap.state === 'disconnected') {
          this.logger.log(
            'Reconnexion IMAP nécessaire, reconnexion en cours...',
          );
          await this.connectToImap();
        }
      } catch (error) {
        this.logger.log('Reconnexion IMAP forcée...');
        await this.connectToImap();
      }

      let totalProcessed = 0;

      for (const category of Object.keys(sortedEmails)) {
        const emailsInCategory = sortedEmails[category].length;
        if (emailsInCategory === 0) continue;

        this.logger.log(
          `Traitement de ${emailsInCategory} email(s) dans la catégorie "${category}"...`,
        );

        // S'assurer que le dossier de catégorie existe
        await this.ensureCategoryExists(category);

        // Ouvrir la boîte INBOX en mode écriture
        await new Promise<void>((resolve, reject) => {
          this.imap.openBox('INBOX', false, (err) => {
            if (err) {
              this.logger.error(
                `Erreur lors de l'ouverture de la boîte: ${err.message}`,
              );
              return reject(err);
            }
            resolve();
          });
        });

        // Déplacer tous les emails de cette catégorie
        // Récupérer les UIDs sous forme de chaînes pour garantir la précision
        const emailUids = sortedEmails[category]
          .filter(email => (email as any).uid) // S'assurer que l'email a un UID
          .map(email => (email as any).uid);
        
        if (emailUids.length === 0) {
          this.logger.warn(`Aucun UID valide trouvé pour la catégorie ${category}`);
          continue;
        }

        this.logger.log(
          `Déplacement de ${emailUids.length} emails vers "${category}"...`,
        );

        // Afficher les UIDs pour le débogage
        this.logger.debug(`UIDs à déplacer: ${emailUids.join(', ')}`);

        // 1. Marquer comme lus
        await new Promise<void>((resolve, reject) => {
          this.imap.setFlags(emailUids, ['\\Seen'], (err) => {
            if (err) {
              this.logger.error(
                `Erreur lors du marquage des emails: ${err.message}`,
              );
              return reject(err);
            }
            this.logger.debug('Emails marqués comme lus avec succès');
            resolve();
          });
        });

        // 2. Copier vers la catégorie - utiliser un nom de dossier sans encodage spécial
        const folderName = this.normalizeMailboxName(category);
        await new Promise<void>((resolve, reject) => {
          this.logger.debug(`Tentative de copie vers le dossier: "${folderName}"`);
          this.imap.copy(emailUids, folderName, (err) => {
            if (err) {
              this.logger.error(
                `Erreur lors de la copie des emails: ${err.message}`,
              );
              return reject(err);
            }
            this.logger.debug(`Emails copiés vers "${folderName}" avec succès`);
            resolve();
          });
        });

        // 3. Marquer pour suppression
        await new Promise<void>((resolve, reject) => {
          this.imap.addFlags(emailUids, ['\\Deleted'], (err) => {
            if (err) {
              this.logger.error(
                `Erreur lors du marquage pour suppression: ${err.message}`,
              );
              return reject(err);
            }
            this.logger.debug('Emails marqués pour suppression avec succès');
            resolve();
          });
        });

        // 4. Expurger (supprimer définitivement)
        await new Promise<void>((resolve, reject) => {
          this.imap.expunge((err) => {
            if (err) {
              this.logger.error(
                `Erreur lors de la suppression définitive: ${err.message}`,
              );
              return reject(err);
            }
            this.logger.log(
              `${emailUids.length} emails déplacés vers "${category}"`,
            );
            resolve();
          });
        });

        totalProcessed += emailUids.length;
        this.logger.log(`Progression: ${totalProcessed} emails traités`);
        
        this.logger.log(
          `Tous les emails de la catégorie "${category}" ont été traités`,
        );
      }

      this.logger.log(
        `Traitement terminé. ${totalProcessed} emails ont été triés et déplacés`,
      );

      // Fermer la connexion IMAP une fois toutes les opérations terminées
      this.closeConnection();
    } catch (error) {
      this.logger.error(
        `Erreur lors du traitement des emails triés: ${error.message}`,
      );
      // S'assurer que la connexion est fermée même en cas d'erreur
      this.closeConnection();
    }
  }

  /**
   * S'assure que le dossier de catégorie existe, le crée si nécessaire
   */
  private async ensureCategoryExists(categoryName: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.imap.getBoxes((err, boxes) => {
        if (err) {
          this.logger.error(
            `Erreur lors de la vérification des dossiers: ${err.message}`,
          );
          return reject(err);
        }

        // Afficher tous les dossiers disponibles pour le débogage
        this.logger.debug(`Dossiers disponibles: ${Object.keys(boxes).join(', ')}`);
        
        // Normaliser le nom de catégorie pour la recherche
        const normalizedName = this.normalizeMailboxName(categoryName);
        this.logger.debug(`Recherche du dossier avec le nom normalisé: "${normalizedName}"`);

        // Vérifier si le dossier existe déjà (vérification insensible à la casse)
        // et prendre en compte les variations d'encodage possibles
        let categoryExists = false;
        let exactBoxName = '';

        // Pour chaque boîte, vérifier si le nom correspond (insensible à la casse)
        Object.keys(boxes).forEach(boxName => {
          if (boxName.toLowerCase() === categoryName.toLowerCase() || 
              boxName === normalizedName) {
            categoryExists = true;
            exactBoxName = boxName; // Conserver le nom exact tel qu'il apparaît dans la liste
            this.logger.debug(`Correspondance trouvée pour le dossier: ${boxName}`);
          }
        });

        // Si le dossier n'existe pas, le créer
        if (!categoryExists) {
          this.logger.log(`Création du dossier "${categoryName}"...`);
          // Utiliser le nom normalisé pour la création
          this.imap.addBox(normalizedName, (addBoxErr) => {
            if (addBoxErr) {
              this.logger.error(
                `Erreur lors de la création du dossier: ${addBoxErr.message}`,
              );
              return reject(addBoxErr);
            }
            this.logger.log(`Dossier "${normalizedName}" créé avec succès`);
            resolve();
          });
        } else {
          this.logger.debug(`Le dossier "${categoryName}" existe déjà (trouvé sous le nom "${exactBoxName}")`);
          resolve();
        }
      });
    });
  }

  /**
   * Analyse les factures triées pour en extraire les informations importantes
   */
  async analyzeInvoices(invoiceEmails: Email[]): Promise<AnalyzedInvoice[]> {
    const analyzedInvoices: AnalyzedInvoice[] = [];

    try {
      this.logger.log(`Analyzing ${invoiceEmails.length} invoice emails`);
      this.logger.log("Démarrage de l'analyse des factures...");

      for (const email of invoiceEmails) {
        this.logger.log(
          `Analyse de la facture: "${email.subject?.substring(0, 30)}..."`,
        );
        const invoiceData = await this.extractInvoiceData(email);
        analyzedInvoices.push(invoiceData);
        this.logger.debug(`Facture analysée et ajoutée à la liste`);
      }

      this.logger.log(
        `Analyse des factures terminée. ${analyzedInvoices.length} factures analysées.`,
      );
      return analyzedInvoices;
    } catch (error) {
      this.logger.error(`Error analyzing invoices: ${error.message}`);
      return [];
    }
  }

  /**
   * Extrait les informations de facture d'un email
   */
  private async extractInvoiceData(email: Email): Promise<AnalyzedInvoice> {
    try {
      this.logger.log(
        `Extraction des données de la facture: "${email.subject?.substring(0, 30)}..."`,
      );

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

      this.logger.debug(
        'Envoi de la requête à OpenAI pour extraction des données de facture...',
      );
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
      let invoiceData: InvoiceData;

      try {
        invoiceData = JSON.parse(resultContent) as InvoiceData;
        this.logger.debug('Données de facture extraites avec succès');
      } catch (e) {
        this.logger.error('Échec du parsing JSON de la réponse OpenAI');
        invoiceData = { error: 'Impossible de parser la réponse JSON' };
      }

      return {
        emailId: email.id,
        subject: email.subject,
        date: email.date,
        invoiceData,
      };
    } catch (error) {
      this.logger.error(`Error extracting invoice data: ${error.message}`);
      return {
        emailId: email.id,
        subject: email.subject,
        date: email.date,
        invoiceData: {},
        error: error.message,
      };
    }
  }

  /**
   * Initialise les catégories à partir des dossiers IMAP
   */
  private async initializeCategories(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.imap.getBoxes((err, boxes) => {
        if (err) {
          this.logger.error(
            `Erreur lors de la récupération des catégories: ${err.message}`,
          );
          // Catégories par défaut en cas d'erreur
          this.categories = ['Autre'];
          return resolve();
        }

        // Extraire les noms de dossiers
        const folderNames = Object.keys(boxes);

        // Filtrer les dossiers spéciaux
        this.categories = folderNames.filter((name) => {
          // Exclure INBOX et les dossiers système comme [Gmail]
          return name !== 'INBOX' && !name.startsWith('[');
        });

        // Ajouter "Autre" comme catégorie par défaut
        if (!this.categories.includes('Autre')) {
          this.categories.push('Autre');
        }

        this.logger.log(
          `Catégories initialisées: ${this.categories.join(', ')}`,
        );
        resolve();
      });
    });
  }

  /**
   * Cherche et classe les emails dans une catégorie spécifique
   */
  async sortEmailsByCategory(
    categoryName: string,
    limit?: number,
  ): Promise<number> {
    try {
      // Vérifier si la catégorie existe
      if (!this.categories.includes(categoryName)) {
        this.logger.warn(
          `La catégorie "${categoryName}" n'existe pas dans les dossiers disponibles`,
        );
        await this.ensureCategoryExists(categoryName);
      }

      this.logger.log(
        `Recherche d'emails pour la catégorie "${categoryName}"...`,
      );

      // Récupérer tous les emails non lus
      const emails = await this.getUnsortedEmails(limit);

      if (emails.length === 0) {
        this.logger.log('Aucun email non lu trouvé');
        return 0;
      }

      this.logger.log(
        `Analyse de ${emails.length} emails pour la catégorie "${categoryName}"`,
      );

      // Filtrer les emails concernés par cette catégorie
      const matchingEmails: Email[] = [];

      for (const email of emails) {
        // Utiliser OpenAI pour déterminer si cet email correspond à la catégorie
        const prompt = `
          Analyse cet email et détermine s'il correspond à la catégorie "${categoryName}".
          
          De: ${email.from}
          À: ${email.to}
          Sujet: ${email.subject}
          Date: ${email.date.toISOString()}
          Contenu: ${email.body.substring(0, 1000)}
          
          Réponds uniquement par OUI ou NON.
        `;

        const response = await this.openai.chat.completions.create({
          model: 'gpt-3.5-turbo',
          messages: [
            {
              role: 'system',
              content: `Tu es un assistant spécialisé dans le tri d'emails. Tu dois déterminer si un email correspond à la catégorie "${categoryName}".`,
            },
            { role: 'user', content: prompt },
          ],
          max_tokens: 10,
          temperature: 0.1,
        });

        const answer =
          response.choices[0]?.message?.content?.trim().toUpperCase() || 'NON';

        if (answer === 'OUI') {
          this.logger.log(
            `Email correspondant à "${categoryName}" trouvé: "${email.subject}"`,
          );
          email.category = categoryName;
          matchingEmails.push(email);
        }
      }

      // Déplacer les emails concernés
      if (matchingEmails.length > 0) {
        this.logger.log(
          `${matchingEmails.length} emails correspondant à "${categoryName}" trouvés, déplacement en cours...`,
        );

        // Créer un objet au format attendu par processSortedEmails
        const sortedEmails = { [categoryName]: matchingEmails };
        await this.processSortedEmails(sortedEmails);

        this.closeConnection();
        return matchingEmails.length;
      } else {
        this.logger.log(
          `Aucun email correspondant à la catégorie "${categoryName}" trouvé`,
        );
        return 0;
      }
    } catch (error) {
      this.closeConnection();
      this.logger.error(`Erreur lors du tri par catégorie: ${error.message}`);
      throw error;
    }
  }

  /**
   * Tri tous les emails (y compris ceux déjà lus) en utilisant l'API OpenAI
   */
  async sortAllEmails(
    limit?: number,
  ): Promise<{ [category: string]: Email[] }> {
    try {
      this.logger.log('Démarrage du processus de tri de tous les emails...');
      const emails = await this.getAllEmails(limit);
      this.logger.log(`Nombre total d'emails à trier: ${emails.length}`);

      const sortedEmails: { [category: string]: Email[] } = {};

      // Initialiser les catégories
      this.categories.forEach((category) => {
        sortedEmails[category] = [];
      });

      // Trier chaque email
      this.logger.log('Classification des emails par catégorie...');
      for (const email of emails) {
        this.logger.log(
          `Traitement de l'email: "${email.subject?.substring(0, 30)}..."`,
        );
        const category = await this.categorizeEmail(email);
        email.category = category;
        sortedEmails[category].push(email);
        this.logger.debug(`Email ajouté à la catégorie: ${category}`);
      }

      // Résumé des résultats de tri
      this.logger.log('Tri des emails terminé. Résumé par catégorie:');
      for (const category of Object.keys(sortedEmails)) {
        const count = sortedEmails[category].length;
        if (count > 0) {
          this.logger.log(`- ${category}: ${count} email(s)`);
        }
      }

      // Ne pas fermer la connexion ici
      return sortedEmails;
    } catch (error) {
      this.closeConnection();
      this.logger.error(`Erreur pendant le tri des emails: ${error.message}`);
      throw error;
    }
  }

  /**
   * Récupère les emails non lus de tous les dossiers
   */
  async getUnsortedEmailsFromAllFolders(limit?: number): Promise<Email[]> {
    try {
      await this.connectToImap();
      const allEmails: Email[] = [];

      // Récupérer tous les dossiers disponibles
      const folders = await new Promise<string[]>((resolve, reject) => {
        this.imap.getBoxes((err, boxes) => {
          if (err) {
            this.logger.error(
              `Erreur lors de la récupération des dossiers: ${err.message}`,
            );
            return reject(err);
          }

          // Extraire les noms de dossiers et filtrer les dossiers spéciaux si nécessaire
          const folderNames = Object.keys(boxes);
          resolve(folderNames);
        });
      });

      this.logger.log(`Dossiers trouvés: ${folders.join(', ')}`);

      // Parcourir chaque dossier
      for (const folder of folders) {
        try {
          this.logger.log(
            `Recherche des emails non lus dans le dossier: ${folder}`,
          );

          await new Promise<void>((resolve, reject) => {
            this.imap.openBox(folder, false, (err) => {
              if (err) {
                this.logger.warn(
                  `Impossible d'ouvrir le dossier ${folder}: ${err.message}`,
                );
                return resolve();
              }
              resolve();
            });
          });

          // Rechercher les emails non lus dans ce dossier
          const folderEmails = await new Promise<Email[]>((resolve, reject) => {
            this.imap.search(['UNSEEN'], (searchErr, results) => {
              if (searchErr) {
                this.logger.error(
                  `Erreur lors de la recherche des emails dans ${folder}: ${searchErr.message}`,
                );
                return resolve([]);
              }

              if (!results || results.length === 0) {
                this.logger.log(`Aucun email non lu trouvé dans ${folder}`);
                return resolve([]);
              }

              this.logger.log(
                `${results.length} emails non lus trouvés dans ${folder}`,
              );

              const emailPromises: Promise<Email>[] = [];
              const fetch = this.imap.fetch(results, {
                bodies: [''],
                struct: true,
                markSeen: false,
              });

              fetch.on('message', (msg, seqno) => {
                const emailPromise = new Promise<Email>(
                  (resolveEmail, rejectEmail) => {
                    const email: Partial<Email> = {
                      id: String(seqno),
                      folderPath: folder,
                    };

                    msg.on('body', (stream) => {
                      let buffer = '';
                      stream.on('data', (chunk) => {
                        buffer += chunk.toString('utf8');
                      });

                      stream.once('end', async () => {
                        try {
                          const parsed = await simpleParser(buffer);

                          email.from = parsed.from?.text || '';
                          email.to = parsed.to?.text || '';
                          email.subject = parsed.subject || '';
                          email.date = parsed.date || new Date();
                          email.body = parsed.text || '';

                          resolveEmail(email as Email);
                        } catch (e) {
                          this.logger.error(
                            `Erreur lors du parsing de l'email: ${e.message}`,
                          );
                          rejectEmail(e);
                        }
                      });
                    });

                    msg.once('attributes', (attrs) => {
                      (email as any).uid = attrs.uid;
                    });
                  },
                );

                emailPromises.push(emailPromise);
              });

              fetch.once('error', (fetchErr) => {
                this.logger.error(
                  `Erreur lors du fetch des emails: ${fetchErr.message}`,
                );
                resolve([]);
              });

              fetch.once('end', () => {
                Promise.all(emailPromises)
                  .then((resolvedEmails) => {
                    resolve(resolvedEmails);
                  })
                  .catch((err) => {
                    this.logger.error(
                      `Erreur lors du traitement des emails: ${err.message}`,
                    );
                    resolve([]);
                  });
              });
            });
          });

          // Ajouter les emails trouvés à la liste complète
          allEmails.push(...folderEmails);
        } catch (folderError) {
          this.logger.error(
            `Erreur lors du traitement du dossier ${folder}: ${folderError.message}`,
          );
          // Continuer avec le dossier suivant
        }
      }

      this.logger.log(
        `Total des emails non lus trouvés dans tous les dossiers: ${allEmails.length}`,
      );
      // Appliquer la limite ici, sur le total des emails collectés
      if (limit && allEmails.length > limit) {
        this.logger.log(
          `Application de la limite: ${limit} emails sur ${allEmails.length} seront retournés.`,
        );
        return allEmails.slice(0, limit);
      }
      return allEmails;
    } catch (error) {
      this.logger.error(
        `Erreur dans getUnsortedEmailsFromAllFolders: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Récupère tous les emails (lus et non lus) de tous les dossiers
   */
  async getAllEmailsFromAllFolders(limit?: number): Promise<Email[]> {
    try {
      await this.connectToImap();
      const allEmails: Email[] = [];

      // Récupérer tous les dossiers disponibles
      const folders = await new Promise<string[]>((resolve, reject) => {
        this.imap.getBoxes((err, boxes) => {
          if (err) {
            this.logger.error(
              `Erreur lors de la récupération des dossiers: ${err.message}`,
            );
            return reject(err);
          }

          // Extraire les noms de dossiers et filtrer les dossiers spéciaux si nécessaire
          const folderNames = Object.keys(boxes);
          resolve(folderNames);
        });
      });

      this.logger.log(`Dossiers trouvés: ${folders.join(', ')}`);

      // Parcourir chaque dossier
      for (const folder of folders) {
        try {
          this.logger.log(
            `Recherche de tous les emails dans le dossier: ${folder}`,
          );

          await new Promise<void>((resolve, reject) => {
            this.imap.openBox(folder, false, (err) => {
              if (err) {
                this.logger.warn(
                  `Impossible d'ouvrir le dossier ${folder}: ${err.message}`,
                );
                return resolve(); // Continuer avec le dossier suivant
              }
              resolve();
            });
          });

          // Rechercher tous les emails dans ce dossier
          const folderEmails = await new Promise<Email[]>((resolve, reject) => {
            this.imap.search(['ALL'], (searchErr, results) => {
              if (searchErr) {
                this.logger.error(
                  `Erreur lors de la recherche des emails dans ${folder}: ${searchErr.message}`,
                );
                return resolve([]); // Continuer avec le dossier suivant
              }

              if (!results || results.length === 0) {
                this.logger.log(`Aucun email trouvé dans ${folder}`);
                return resolve([]);
              }

              this.logger.log(
                `${results.length} emails trouvés dans ${folder}`,
              );

              const emailPromises: Promise<Email>[] = [];
              const fetch = this.imap.fetch(results, {
                bodies: [''],
                struct: true,
                markSeen: false,
              });

              fetch.on('message', (msg, seqno) => {
                const emailPromise = new Promise<Email>(
                  (resolveEmail, rejectEmail) => {
                    const email: Partial<Email> = {
                      id: String(seqno),
                      folderPath: folder,
                    };

                    msg.on('body', (stream) => {
                      let buffer = '';
                      stream.on('data', (chunk) => {
                        buffer += chunk.toString('utf8');
                      });

                      stream.once('end', async () => {
                        try {
                          const parsed = await simpleParser(buffer);

                          email.from = parsed.from?.text || '';
                          email.to = parsed.to?.text || '';
                          email.subject = parsed.subject || '';
                          email.date = parsed.date || new Date();
                          email.body = parsed.text || '';

                          resolveEmail(email as Email);
                        } catch (e) {
                          this.logger.error(
                            `Erreur lors du parsing de l'email: ${e.message}`,
                          );
                          rejectEmail(e);
                        }
                      });
                    });

                    msg.once('attributes', (attrs) => {
                      (email as any).uid = attrs.uid;
                    });
                  },
                );

                emailPromises.push(emailPromise);
              });

              fetch.once('error', (fetchErr) => {
                this.logger.error(
                  `Erreur lors du fetch des emails: ${fetchErr.message}`,
                );
                resolve([]);
              });

              fetch.once('end', () => {
                Promise.all(emailPromises)
                  .then((resolvedEmails) => {
                    resolve(resolvedEmails);
                  })
                  .catch((err) => {
                    this.logger.error(
                      `Erreur lors du traitement des emails: ${err.message}`,
                    );
                    resolve([]);
                  });
              });
            });
          });

          // Ajouter les emails trouvés à la liste complète
          allEmails.push(...folderEmails);
        } catch (folderError) {
          this.logger.error(
            `Erreur lors du traitement du dossier ${folder}: ${folderError.message}`,
          );
          // Continuer avec le dossier suivant
        }
      }

      this.logger.log(
        `Total des emails trouvés dans tous les dossiers: ${allEmails.length}`,
      );
      // Appliquer la limite ici, sur le total des emails collectés
      if (limit && allEmails.length > limit) {
        this.logger.log(
          `Application de la limite: ${limit} emails sur ${allEmails.length} seront retournés.`,
        );
        return allEmails.slice(0, limit);
      }
      return allEmails;
    } catch (error) {
      this.logger.error(
        `Erreur dans getAllEmailsFromAllFolders: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Tri les emails non lus de tous les dossiers
   */
  async sortEmailsFromAllFolders(
    limit?: number,
  ): Promise<{ [category: string]: Email[] }> {
    try {
      this.logger.log(
        'Démarrage du tri des emails non lus de tous les dossiers...',
      );
      const emails = await this.getUnsortedEmailsFromAllFolders(limit);
      this.logger.log(
        `Nombre total d'emails non lus à trier: ${emails.length}`,
      );

      // Continuer avec le même processus de tri
      const sortedEmails: { [category: string]: Email[] } = {};

      // Initialiser les catégories
      this.categories.forEach((category) => {
        sortedEmails[category] = [];
      });

      // Trier chaque email
      this.logger.log('Classification des emails non lus par catégorie...');
      for (const email of emails) {
        this.logger.log(
          `Traitement de l'email: "${email.subject?.substring(0, 30)}..."`,
        );
        const category = await this.categorizeEmail(email);
        email.category = category;
        sortedEmails[category].push(email);
      }

      // Résumé des résultats
      this.logger.log('Tri des emails non lus terminé. Résumé par catégorie:');
      for (const category of Object.keys(sortedEmails)) {
        const count = sortedEmails[category].length;
        if (count > 0) {
          this.logger.log(`- ${category}: ${count} email(s)`);
        }
      }

      return sortedEmails;
    } catch (error) {
      this.closeConnection();
      this.logger.error(
        `Erreur pendant le tri des emails non lus: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Tri tous les emails (lus et non lus) de tous les dossiers
   */
  async sortAllEmailsFromAllFolders(
    limit?: number,
  ): Promise<{ [category: string]: Email[] }> {
    try {
      this.logger.log(
        'Démarrage du tri de tous les emails de tous les dossiers...',
      );
      const emails = await this.getAllEmailsFromAllFolders(limit);
      this.logger.log(`Nombre total d'emails à trier: ${emails.length}`);

      // Continuer avec le même processus de tri
      const sortedEmails: { [category: string]: Email[] } = {};

      // Initialiser les catégories
      this.categories.forEach((category) => {
        sortedEmails[category] = [];
      });

      // Trier chaque email
      this.logger.log('Classification de tous les emails par catégorie...');
      for (const email of emails) {
        this.logger.log(
          `Traitement de l'email: "${email.subject?.substring(0, 30)}..."`,
        );
        const category = await this.categorizeEmail(email);
        email.category = category;
        sortedEmails[category].push(email);
      }

      // Résumé des résultats
      this.logger.log('Tri de tous les emails terminé. Résumé par catégorie:');
      for (const category of Object.keys(sortedEmails)) {
        const count = sortedEmails[category].length;
        if (count > 0) {
          this.logger.log(`- ${category}: ${count} email(s)`);
        }
      }

      return sortedEmails;
    } catch (error) {
      this.closeConnection();
      this.logger.error(
        `Erreur pendant le tri de tous les emails: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Normalise les noms de dossiers pour gérer les problèmes d'encodage
   * Particulièrement utile pour les dossiers avec caractères accentués
   */
  private normalizeMailboxName(folderName: string): string {
    // Table de correspondance pour les noms de dossiers spéciaux
    const specialFolders: Record<string, string> = {
      'Reçus': 'Re&AOc-us', // Encodage spécial observé dans les logs
      'Envoyés': 'Envoy&AOk-s',
    };

    // Si le nom est dans notre table de correspondance, utiliser la version encodée
    if (specialFolders[folderName]) {
      this.logger.debug(`Nom de dossier normalisé: "${folderName}" -> "${specialFolders[folderName]}"`);
      return specialFolders[folderName];
    }

    return folderName;
  }
}
