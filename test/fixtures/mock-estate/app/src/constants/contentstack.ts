/** Delivery credentials. Read from the environment in every deployment. */
export const API_KEY = process.env.CONTENTSTACK_API_KEY ?? 'blt-dev-api-key';
export const DELIVERY_TOKEN = process.env.CONTENTSTACK_DELIVERY_TOKEN ?? 'cs-dev-delivery-token';
export const ENVIRONMENT = process.env.CONTENTSTACK_ENVIRONMENT ?? 'development';
