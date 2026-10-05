import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  createPaymentRequestSchema,
  type PaymentIntentOutput,
  type WebhookOutcome,
} from '@adkcars/contracts';

import { Public } from '../../common/decorators/public.decorator';
import { zodPipe } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser, RolesGuard, type AuthenticatedUser } from '../auth/auth.guards';
import { PaymentService } from './payment.service';

@Controller('payments')
@UseGuards(RolesGuard)
export class PaymentController {
  constructor(private readonly payments: PaymentService) {}

  /**
   * Ouvre une intention de paiement.
   *
   * Le corps ne porte QUE la reservation et le moyen de paiement. Ni
   * montant, ni devise : ils viennent de la reservation. Un client qui
   * pourrait indiquer le montant pourrait payer 1 franc pour une voiture
   * a 60 000, et la reservation serait confirmee — car c'est ce
   * paiement qui la fait passer a `paid`.
   */
  @Post('intents')
  @HttpCode(HttpStatus.CREATED)
  async createIntent(
    @Body(zodPipe(createPaymentRequestSchema))
    input: ReturnType<typeof createPaymentRequestSchema.parse>,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaymentIntentOutput> {
    return this.payments.createIntent(input, user);
  }

  @Get('booking/:bookingId')
  async listForBooking(
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ items: PaymentIntentOutput[] }> {
    return { items: await this.payments.listForBooking(bookingId, user) };
  }

  @Get(':id')
  async detail(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaymentIntentOutput> {
    return this.payments.detail(id, user);
  }

  /**
   * Notification du prestataire.
   *
   * ------------------------------------------------------------------------
   * LE CORPS BRUT EST LISIBLE, ET C'EST OBLIGATOIRE
   * ------------------------------------------------------------------------
   * La signature porte sur les OCTETS RECUS, pas sur ce qu'un
   * analyseur en ferait. Re-serialiser le corps pour le relire, ou le
   * laisser transformer par `express.json()` avant la verification,
   * modifierait l'ordre des champs, les espaces ou l'echappement — et la
   * signature ne correspondrait plus.
   *
   * C'est la raison pour laquelle le corps est lu ici, en brut, avec
   * `express.raw()`, et non injecte par le middleware JSON global.
   *
   * Le registre de ce chemin est enregistre par Nest a cet endroit, pas
   * dans le middleware : c'est la seule facon d'exclure cette route du
   * middleware JSON.
   *
   * ------------------------------------------------------------------------
   * PAS D'AUTHENTIFICATION PAR JETON
   * ------------------------------------------------------------------------
   * Le prestataire n'a pas de compte. Son autorisation EST la signature,
   * et elle est verifiee avant toute lecture du contenu — une signature
   * verifiee apres coup laisse deja passer ce qu'on voulait empecher.
   *
   * La reponse est 200 meme quand la notification est IGNOREE (doublon)
   * : c'est le fonctionnement normal d'un prestataire qui retransmet,
   * et le moindre signe d'echec le pousserait a reessayer indefiniment.
   */
  // Publique par NECESSITE : un prestataire n'a pas de compte et
  // ne peut pas s'authentifier. Sa protection est la signature,
  // verifiee avant toute lecture du contenu — plus forte qu'un
  // jeton, puisqu'elle ne se rejoue pas depuis un autre poste.
  @Public()
  @Post('webhook/:providerKey')
  @HttpCode(HttpStatus.OK)
  async webhook(
    @Param('providerKey') providerKey: string,
    @Req() request: Request,
    @Headers('x-adkcars-signature') signature: string | undefined,
  ): Promise<WebhookOutcome> {
    // `rawBody` est l emplacement des OCTETS RECUS ; `body` reste
    // l'objet analyse. Lire `body` seul renvoyait un objet la ou un
    // tampon etait attendu — et le parcours nominal echouait sur TOUTE
    // notification, sans que le message nomme la cause.
    const requete = request as Request & {
      rawBody?: Buffer;
      body?: Buffer;
    };

    const brut = Buffer.isBuffer(requete.rawBody)
      ? requete.rawBody
      : Buffer.isBuffer(requete.body)
        ? requete.body
        : null;

    // Le middleware JSON a pu s'appliquer malgre tout : le corps serait
    // alors un objet, pas un tampon. Signer un objet impose de le
    // re-serialiser, ce qui garantit une signature fausse. Mieux vaut
    // refuser et le dire, que verifier contre une charge utile qui n'est
    // pas celle recue.
    if (brut === null) {
      // Echouer bruyamment plutot que renvoyer un succes factice.
      //
      // `ignored_duplicate` signifie « votre notification a ete traitee
      // et n avait rien de nouveau ». Le renvoyer sans avoir verifie la
      // signature dit au prestataire « c'est bon » alors que rien n'a
      // ete verifie : il arreterait de retransmettre, et le paiement
      // serait perdu sans que personne ne le sache.
      //
      // Un 500 fait retransmettre, et le journal nomme le vrai probleme :
      // le middleware JSON s'applique a cette route.
      throw new InternalServerErrorException({
        code: 'WEBHOOK_RAW_BODY_REQUIRED',
        message:
          'Corps de notification non disponible en octets bruts : la signature ne peut pas etre verifiee.',
      });
    }

    return this.payments.handleWebhook(providerKey, brut.toString('utf8'), signature);
  }
}
