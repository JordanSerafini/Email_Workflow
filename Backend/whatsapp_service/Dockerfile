FROM node:18-alpine AS build

# Créer le répertoire de travail
WORKDIR /app

# Copier package.json et package-lock.json
COPY package*.json ./

# Installer les dépendances
RUN npm ci

# Copier le code source
COPY . .

# Compiler l'application
RUN npm run build

# Image de production
FROM node:18-alpine

WORKDIR /app

# Copier les fichiers compilés et les dépendances
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package*.json ./

# Exposer le port
EXPOSE 3003

# Démarrer l'application
CMD ["node", "dist/main.js"] 