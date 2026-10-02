import { SetMetadata } from '@nestjs/common';

import { IS_PUBLIC_KEY } from '../tokens';

export { IS_PUBLIC_KEY } from '../tokens';

/**
 * Marque une route comme accessible sans jeton.
 *
 * Regle par defaut (CDCS 12.3) : toute route est PRIVEE. L'oubli d'un
 * decorateur sur une nouvelle route doit echouer, pas exposer une
 * ressource : le defaut est donc « protege ».
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);