# Module de Parsing de Factures

Ce module permet d'extraire automatiquement les informations des factures PDF en utilisant l'API OpenAI.

## Fonctionnalités

- Scan automatique du dossier `Factures/Originales` pour trouver les fichiers PDF
- Extraction du texte des PDF
- Analyse du texte avec l'API OpenAI pour extraire les informations structurées
- Conversion des résultats en format JSON

## Prérequis

- Node.js et npm
- Clé API OpenAI configurée dans les variables d'environnement
- Bibliothèque pdf-parse (`npm install pdf-parse`)

## Configuration

1. Assurez-vous que votre clé API OpenAI est configurée dans le fichier `.env` :
   ```
   OPENAI_API_KEY=votre_clé_api
   ```

2. Placez vos factures PDF dans le dossier `Factures/Originales`

## Utilisation de l'API

### Lister les fichiers de factures disponibles

```
GET /invoice-parser/files
```

### Traiter une facture spécifique

```
GET /invoice-parser/process/:filename
```

### Traiter toutes les factures

```
POST /invoice-parser/process-all
```

## Structure des résultats

L'API renvoie les informations extraites des factures au format JSON, avec la structure suivante :

```json
{
  "filename": "nom_du_fichier.pdf",
  "data": {
    "fournisseur": "Nom du fournisseur",
    "numero": "Numéro de facture",
    "date": "Date de facture",
    "produits": [
      {
        "description": "Description du produit",
        "quantite": 1,
        "prix_unitaire": 100,
        "montant": 100
      }
    ],
    "montant_ht": 100,
    "tva": 20,
    "montant_ttc": 120
  },
  "success": true
}
```

En cas d'erreur, le champ `success` sera à `false` et un champ `error` contiendra le message d'erreur.

## Dépannage

- Si vous rencontrez une erreur liée à pdf-parse, vérifiez que la bibliothèque est bien installée : `npm install pdf-parse`
- Si l'API OpenAI ne répond pas, vérifiez votre clé API et votre connexion internet
- Si le texte extrait est de mauvaise qualité, essayez d'améliorer la qualité de vos fichiers PDF 