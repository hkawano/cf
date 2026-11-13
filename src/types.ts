export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_URL: string;
  EMAIL_FROM: string;
  RESEND_API_KEY?: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PRICE_ID: string;
};

export type User = { id: string; email: string };

export type Vars = { user: User | null };

export type AppEnv = { Bindings: Env; Variables: Vars };
