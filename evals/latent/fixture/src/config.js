// Synthetic fixture for the M2a latent read evals. Not a real service.
// Orbit Shop: a tiny storefront used to ask questions about a codebase.

export const REGION = 'eu-west';
export const CURRENCY = 'EUR';

// Sessions last thirty minutes unless refreshed.
export const SESSION_TTL_SECONDS = 1800;

// A refresh slides the expiry forward by this much, never past the hard cap.
export const SESSION_REFRESH_SECONDS = 900;
export const SESSION_HARD_CAP_SECONDS = 7200;

// Carts above this size are rejected before pricing.
export const MAX_CART_ITEMS = 40;

// Value-added tax applied to every order total.
export const TAX_RATE = 0.2;

// Payment provider retries.
export const RETRY_LIMIT = 3;
export const RETRY_BASE_MS = 250;

// Refunds are accepted for this many days after payment.
export const REFUND_WINDOW_DAYS = 14;

export const MAIL_QUEUE = 'orbit-mail';
export const SMS_QUEUE = 'orbit-sms';
