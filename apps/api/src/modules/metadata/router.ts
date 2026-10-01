import { Models } from '@ibt/db';
import { AppError, PublicKeySchema, TokenMetadataSchema, type TokenMetadata } from '@ibt/shared';
import { Router } from 'express';

import type { AppContext } from '../../app.js';

const SYMBOL_MAX = 10;

function fallbackSymbol(slug: string): string {
  return (
    slug
      .replace(/[^a-z0-9]/gi, '')
      .toUpperCase()
      .slice(0, SYMBOL_MAX) || 'IBT'
  );
}

/** Metaplex-style JSON (L229); pending mints resolve too, so the URI is live before signing. */
export async function tokenMetadata(ctx: AppContext, mint: string): Promise<TokenMetadata> {
  const row = await Models.findOne({ 'token.mint': mint })
    .select({ slug: 1, name: 1, description: 1, imageUrl: 1, token: 1 })
    .lean();
  if (!row) throw new AppError('not_found', { message: 'unknown mint' });
  return TokenMetadataSchema.parse({
    name: row.name,
    symbol: row.token.symbol ?? fallbackSymbol(row.slug),
    description: row.description ?? '',
    image: row.imageUrl ?? '',
    external_url: new URL(`/t/${encodeURIComponent(row.slug)}`, ctx.env.WEB_ORIGIN).toString(),
    attributes: [{ trait_type: 'model', value: row.slug }],
  });
}

export function metadataRouter(ctx: AppContext): Router {
  const router = Router();

  // path-to-regexp v8 has no `:mint.json` suffix syntax (G9); strip it here.
  router.get('/:file', async (req, res) => {
    const mint = req.params.file.replace(/\.json$/, '');
    if (!PublicKeySchema.safeParse(mint).success) {
      throw new AppError('not_found', { message: 'unknown mint' });
    }
    res.json(await tokenMetadata(ctx, mint));
  });

  return router;
}
