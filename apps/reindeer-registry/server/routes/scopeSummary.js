import { Router } from 'express';

/**
 * Scope-summary route.
 *
 *   GET /api/scope-summary
 *
 * Returns the household-shape signals a client needs to render the
 * right UI without walking every feature endpoint:
 *
 *   {
 *     scope_id, scope_type, name, owner_name,
 *     household_mode: 'solo' | 'couple' | 'survivor',
 *     linked_household_id: string | null,
 *     participant: { participant_id, email, is_bootstrap: bool },
 *     participants: { count: number },
 *   }
 *
 * Household mode defaults to 'solo' for every existing scope (migration
 * 13's default). Slice 3 does not flip any scope to 'couple' \u2014 that
 * transition ships with the couple-link ceremony in a later slice.
 */
export function createScopeSummaryRouter({ registry, participants, resolveScope }) {
  const r = Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  r.get('/scope-summary', wrap(async (req, res) => {
    const ctx = resolveScope(req);
    const scope = registry.getScope(ctx);
    const count = participants.count?.() ?? 0;
    res.json({
      scope_id: scope?.scope_id ?? ctx.scopeId,
      scope_type: scope?.scope_type ?? ctx.scopeType,
      name: scope?.name ?? null,
      owner_name: scope?.owner_name ?? '',
      household_mode: scope?.household_mode ?? 'solo',
      linked_household_id: scope?.linked_household_id ?? null,
      participant: {
        participant_id: req.participant?.participant_id ?? null,
        email: req.participant?.email ?? null,
        role: req.participant?.role ?? null,
        is_bootstrap: req.participant?.participant_id === 'bootstrap-owner',
      },
      participants: { count },
    });
  }));

  return r;
}
