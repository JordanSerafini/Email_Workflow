import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import OpenAI from 'openai';

@Injectable()
export class InvoiceParserService {
  private readonly openai: OpenAI;
  private readonly pdfBasePath: string;
  private readonly resultsPath: string;

  constructor(private configService: ConfigService) {
    this.openai = new OpenAI({
      apiKey: this.configService.get<string>('OPENAI_API_KEY'),
    });

    // Chemins absolus vers les dossiers
    this.pdfBasePath = path.join(process.cwd(), 'Factures', 'Originales');
    this.resultsPath = path.join(process.cwd(), 'Factures', 'Resultats');
    
    // Créer le dossier Resultats s'il n'existe pas
    this.ensureDirectoryExists(this.resultsPath);
  }

  /**
   * S'assure que le répertoire existe, le crée sinon
   */
  private ensureDirectoryExists(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      console.log(`[InvoiceParser] Création du dossier: ${dirPath}`);
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  /**
   * Récupère la liste de tous les fichiers PDF et images dans le dossier des factures
   */
  async getInvoiceFiles(): Promise<string[]> {
    try {
      const files = await fs.promises.readdir(this.pdfBasePath);
      // Accepter les extensions PDF, PNG, JPG et JPEG
      const filteredFiles = files.filter((file) => {
        const ext = file.toLowerCase().split('.').pop() || '';
        return ['pdf', 'png', 'jpg', 'jpeg'].includes(ext);
      });
      
      console.log(`[InvoiceParser] Fichiers trouvés (${filteredFiles.length}):`, filteredFiles);
      return filteredFiles;
    } catch (error) {
      console.error(`Erreur lors de la lecture du dossier: ${error.message}`);
      throw new Error(
        `Impossible de lire le dossier des factures: ${error.message}`,
      );
    }
  }

  /**
   * Détermine si le fichier est une image ou un PDF
   */
  private isImageFile(filePath: string): boolean {
    const ext = filePath.toLowerCase().split('.').pop() || '';
    const isImage = ['png', 'jpg', 'jpeg'].includes(ext);
    console.log(`[InvoiceParser] Type de fichier: ${filePath} -> ${isImage ? 'IMAGE' : 'PDF'}`);
    return isImage;
  }

  /**
   * Extrait le texte d'un fichier (PDF ou image)
   */
  async extractTextFromPdf(filePath: string): Promise<string> {
    try {
      console.log(`[InvoiceParser] Extraction du texte depuis: ${filePath}`);
      
      // Si c'est une image, on ne peut pas extraire directement le texte,
      // donc on retourne un message indiquant qu'on va l'envoyer directement à OpenAI
      if (this.isImageFile(filePath)) {
        console.log(`[InvoiceParser] Format d'image détecté, préparation pour l'API Vision`);
        return `[ANALYSE D'IMAGE: ${path.basename(filePath)}]`;
      }

      // Sinon, on procède comme avant pour les PDFs
      let pdfParse;
      try {
        // Import dynamique de pdf-parse
        pdfParse = require('pdf-parse');
      } catch (importError) {
        console.error('Module pdf-parse non disponible:', importError.message);
        return `[ERREUR: Module pdf-parse non disponible. Veuillez l'installer avec 'npm install pdf-parse'.]`;
      }

      const dataBuffer = await fs.promises.readFile(filePath);
      const data = await pdfParse(dataBuffer);
      return data.text;
    } catch (error) {
      console.error(`Erreur lors de l'extraction du texte: ${error.message}`);
      return `[ERREUR: Impossible d'extraire le texte du fichier: ${error.message}]`;
    }
  }

  /**
   * Nettoie la réponse JSON qui peut contenir des délimiteurs markdown
   */
  private cleanJsonResponse(jsonContent: string): string {
    // Si la réponse contient des délimiteurs markdown de code, les supprimer
    if (jsonContent.startsWith('```')) {
      console.log(`[InvoiceParser] Nettoyage des délimiteurs markdown dans la réponse`);
      
      // Supprime les délimiteurs de début (```json, ```javascript, etc.)
      let cleaned = jsonContent.replace(/^```[a-z]*\n/, '');
      
      // Supprime les délimiteurs de fin
      cleaned = cleaned.replace(/\n```$/, '');
      
      return cleaned;
    }
    
    return jsonContent;
  }

  /**
   * Envoie le texte extrait à l'API OpenAI pour analyse
   * Pour les images, on les envoie directement à l'API
   */
  async analyzeInvoiceText(text: string, filePath?: string): Promise<any> {
    try {
      // Si on a une indication d'analyse d'image, on procède différemment
      const isImageAnalysis = text.startsWith("[ANALYSE D'IMAGE:");
      console.log(`[InvoiceParser] Analyse de texte - Mode image: ${isImageAnalysis}`);
      
      // Si le texte indique une erreur d'extraction, renvoyer directement l'erreur
      if (text.startsWith('[ERREUR:')) {
        console.log(`[InvoiceParser] Erreur détectée dans le texte: ${text}`);
        return { error: text };
      }

      let response;

      if (isImageAnalysis && filePath) {
        console.log(`[InvoiceParser] Préparation de l'image pour l'API Vision: ${filePath}`);
        const imageBuffer = await fs.promises.readFile(filePath);
        const base64Image = imageBuffer.toString('base64');
        console.log(`[InvoiceParser] Image convertie en base64: ${base64Image.substring(0, 50)}...`);
                
        console.log(`[InvoiceParser] Envoi de l'image à l'API OpenAI...`);
        response = await this.openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            { 
              role: 'user', 
              content: [
                { 
                  type: 'text', 
                  text: 'Voici une facture au format image. Extrais toutes les informations importantes comme le fournisseur, la date, le numéro, les produits, quantités, prix unitaires et les montants totaux. Fournis la réponse au format JSON sans aucun autre texte ni délimiteur markdown.'
                },
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:image/png;base64,${base64Image}`
                  }
                }
              ]
            }
          ],
          temperature: 0,
        });
        console.log(`[InvoiceParser] Réponse reçue de l'API Vision`);
      } else {
        // Pour le texte extrait de PDF, on procède comme avant
        console.log(`[InvoiceParser] Envoi du texte à l'API OpenAI...`);
        const prompt = `Voici une facture au format texte. Récupère le fournisseur, la date, le numéro, les produits, et les montants en JSON sans aucun autre texte ni délimiteur markdown :\n\n${text}`;
        
        response = await this.openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
        });
        console.log(`[InvoiceParser] Réponse reçue de l'API OpenAI pour le texte`);
      }
      
      // Récupérer le contenu JSON de la réponse
      const jsonContent = response.choices[0].message.content || '';
      console.log(`[InvoiceParser] Contenu JSON reçu: ${jsonContent.substring(0, 100)}...`);
      
      // Nettoyer la réponse JSON si elle contient des délimiteurs markdown
      const cleanedJsonContent = this.cleanJsonResponse(jsonContent);
      
      try {
        // Tenter de parser la réponse en JSON
        if (cleanedJsonContent) {
          console.log(`[InvoiceParser] Tentative de parsing JSON...`);
          const parsedJson = JSON.parse(cleanedJsonContent);
          console.log(`[InvoiceParser] JSON parsé avec succès`);
          return parsedJson;
        } else {
          console.log(`[InvoiceParser] Réponse vide de l'API OpenAI`);
          return { error: "Réponse vide de l'API OpenAI" };
        }
      } catch (parseError) {
        console.error(`Erreur lors du parsing JSON: ${parseError.message}`);
        // Renvoyer le texte brut si le parsing échoue
        return { rawResponse: cleanedJsonContent };
      }
    } catch (error) {
      console.error(`Erreur lors de l'analyse OpenAI: ${error.message}`);
      return {
        error: `Erreur lors de l'analyse de la facture: ${error.message}`,
      };
    }
  }

  /**
   * Enregistre les résultats au format JSON
   */
  private saveResultAsJson(filename: string, data: any): string | undefined {
    const baseName = path.basename(filename, path.extname(filename));
    const jsonFilePath = path.join(this.resultsPath, `${baseName}.jsonb`);
    
    try {
      fs.writeFileSync(jsonFilePath, JSON.stringify(data, null, 2));
      console.log(`[InvoiceParser] Résultat enregistré en JSON: ${jsonFilePath}`);
      return jsonFilePath;
    } catch (error) {
      console.error(`[InvoiceParser] Erreur lors de l'enregistrement JSON: ${error.message}`);
      return undefined;
    }
  }

  /**
   * Convertit les données JSON en format CSV
   */
  private convertToCsv(data: any): string {
    try {
      // Extraction des données pour le CSV
      const fournisseur = data.fournisseur || '';
      const numero = data.numero || '';
      const date = data.date || '';
      const montantHT = data.montant_ht || data.total_ht || '';
      const montantTTC = data.montant_ttc || data.total_ttc || '';
      
      // Entêtes CSV
      let csvContent = 'Fournisseur,Numéro,Date,MontantHT,MontantTTC\n';
      
      // Ligne de données
      csvContent += `"${fournisseur}","${numero}","${date}","${montantHT}","${montantTTC}"\n`;
      
      // Si des produits sont présents, ajouter une section pour eux
      if (data.produits && Array.isArray(data.produits) && data.produits.length > 0) {
        csvContent += '\nProduits:\nDescription,Quantité,PrixUnitaire,Montant\n';
        
        data.produits.forEach(produit => {
          const description = produit.description || '';
          const quantite = produit.quantite || produit.qte || '';
          const prixUnitaire = produit.prix_unitaire || produit.pu || '';
          const montant = produit.montant || '';
          
          csvContent += `"${description}","${quantite}","${prixUnitaire}","${montant}"\n`;
        });
      }
      
      return csvContent;
    } catch (error) {
      console.error(`[InvoiceParser] Erreur lors de la conversion en CSV: ${error.message}`);
      return `Erreur de conversion: ${error.message}`;
    }
  }

  /**
   * Enregistre les résultats au format CSV
   */
  private saveResultAsCsv(filename: string, data: any): string | undefined {
    const baseName = path.basename(filename, path.extname(filename));
    const csvFilePath = path.join(this.resultsPath, `${baseName}.csv`);
    
    try {
      const csvContent = this.convertToCsv(data);
      fs.writeFileSync(csvFilePath, csvContent);
      console.log(`[InvoiceParser] Résultat enregistré en CSV: ${csvFilePath}`);
      return csvFilePath;
    } catch (error) {
      console.error(`[InvoiceParser] Erreur lors de l'enregistrement CSV: ${error.message}`);
      return undefined;
    }
  }

  /**
   * Traite une facture spécifique (PDF ou image)
   */
  async processInvoice(filename: string): Promise<any> {
    try {
      console.log(`[InvoiceParser] Traitement de la facture: ${filename}`);
      const filePath = path.join(this.pdfBasePath, filename);
      
      // Vérifier si le fichier existe
      if (!fs.existsSync(filePath)) {
        console.log(`[InvoiceParser] Fichier introuvable: ${filePath}`);
        throw new Error(`Le fichier ${filename} n'existe pas`);
      }
      
      // Extraire le texte du PDF ou identifier l'image
      console.log(`[InvoiceParser] Extraction du contenu...`);
      const invoiceText = await this.extractTextFromPdf(filePath);
      
      // Analyser le texte avec OpenAI (ou envoyer directement l'image)
      console.log(`[InvoiceParser] Analyse avec OpenAI...`);
      const analysisResult = await this.analyzeInvoiceText(invoiceText, filePath);
      
      console.log(`[InvoiceParser] Résultat de l'analyse:`, analysisResult);
      
      // Enregistrer les résultats si l'analyse a réussi
      if (analysisResult && !analysisResult.error) {
        // Enregistrer au format JSON
        this.saveResultAsJson(filename, analysisResult);
        
        // Enregistrer au format CSV
        this.saveResultAsCsv(filename, analysisResult);
      }
      
      return {
        filename,
        data: analysisResult,
        success: !analysisResult.error,
      };
    } catch (error) {
      console.error(
        `Erreur lors du traitement de la facture ${filename}: ${error.message}`,
      );
      return {
        filename,
        error: error.message,
        success: false,
      };
    }
  }

  /**
   * Traite toutes les factures PDF disponibles
   */
  async processAllInvoices(): Promise<any[]> {
    try {
      // Récupérer tous les fichiers PDF
      const pdfFiles = await this.getInvoiceFiles();

      if (pdfFiles.length === 0) {
        return [
          {
            message: 'Aucune facture PDF trouvée dans le dossier',
            success: false,
          },
        ];
      }

      // Traiter chaque fichier
      const results = await Promise.all(
        pdfFiles.map((file) => this.processInvoice(file)),
      );

      return results;
    } catch (error) {
      console.error(`Erreur lors du traitement des factures: ${error.message}`);
      return [
        {
          error: `Impossible de traiter les factures: ${error.message}`,
          success: false,
        },
      ];
    }
  }
}
