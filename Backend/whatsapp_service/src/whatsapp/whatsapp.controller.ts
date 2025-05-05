import { Body, Controller, Get, Logger, Post, Query } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';

@Controller('webhook')
export class WhatsappController {
  private readonly logger = new Logger(WhatsappController.name);

  constructor(private readonly whatsappService: WhatsappService) {}

  /**
   * Point d'entrée pour la vérification du webhook WhatsApp
   * Cette méthode est appelée par Facebook lors de la configuration initiale
   */
  @Get()
  verifyWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ): string {
    this.logger.log('Requête de vérification de webhook reçue');

    if (this.whatsappService.verifyWebhook(mode, token)) {
      this.logger.log('Vérification du webhook réussie');
      return challenge;
    }

    this.logger.warn('Échec de la vérification du webhook: token invalide');
    return 'Token de vérification invalide';
  }

  /**
   * Point d'entrée pour les notifications WhatsApp
   * Cette méthode est appelée par Facebook lorsqu'un message est reçu
   */
  @Post()
  async handleWebhook(@Body() body: any): Promise<string> {
    try {
      this.logger.log('Notification webhook reçue');

      // Vérifier si c'est une notification de message
      if (
        body?.object === 'whatsapp_business_account' &&
        body?.entry &&
        body.entry[0]?.changes &&
        body.entry[0].changes[0]?.value?.messages &&
        body.entry[0].changes[0].value.messages[0]
      ) {
        const message = body.entry[0].changes[0].value.messages[0];

        // Ne traiter que les messages texte
        if (message.type === 'text') {
          // Traiter le message de manière asynchrone pour répondre rapidement au webhook
          setImmediate(() => {
            this.whatsappService
              .handleIncomingMessage(message)
              .catch((error) =>
                this.logger.error(
                  `Erreur lors du traitement du message: ${error.message}`,
                ),
              );
          });
        } else {
          this.logger.log(`Message de type non supporté reçu: ${message.type}`);
        }
      }

      // Toujours retourner un statut 200 pour confirmer la réception
      return 'OK';
    } catch (error) {
      this.logger.error(
        `Erreur lors du traitement du webhook: ${error.message}`,
      );
      // Toujours retourner un statut 200 pour confirmer la réception
      return 'OK';
    }
  }
}
