/**
 * Minimal ambient types for two small transitive dependencies
 * (`cookie` and `cookie-signature`, both already installed as dependencies
 * of `express-session`) that ship no types of their own and have no
 * `@types/*` package pulled in by this app. Only the surface
 * server/auth/cookies.ts actually calls.
 */
declare module "cookie" {
  export function parse(str: string): Record<string, string>;
  export function serialize(
    name: string,
    value: string,
    options?: Record<string, unknown>,
  ): string;
}

declare module "cookie-signature" {
  export function sign(value: string, secret: string): string;
  export function unsign(value: string, secret: string): string | false;
}
