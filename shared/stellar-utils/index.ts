/**
 * Stellar network utilities
 * Provides helpers for interacting with the Stellar blockchain
 */

import { StrKey } from '@stellar/stellar-sdk';
import type { Amount, Stroops } from '@bettapay/shared-types';

export function validateStellarAddress(address: string): boolean {
  return StrKey.isValidEd25519PublicKey(address);
}

/**
 * Builds a normalized Stellar set-options operation object for multi-signature
 * account configuration. Supports master weight, signing thresholds, and additional
 * signers. All threshold and weight values must be integers in the range 0–255.
 *
 * @param params.masterWeight  Weight of the account's master key (0 removes signing authority)
 * @param params.lowThreshold  Threshold for low-security operations
 * @param params.medThreshold  Threshold for medium-security operations
 * @param params.highThreshold Threshold for high-security operations
 * @param params.signer        Additional signer to add or remove from the account
 * @throws {Error} When any threshold or weight value is outside 0–255
 * @throws {Error} When signer.key is not a valid Stellar address
 */
export function buildSetOptionsOp(params: {
  masterWeight?: number;
  lowThreshold?: number;
  medThreshold?: number;
  highThreshold?: number;
  signer?: { key: string; weight: number };
}): {
  type: 'setOptions';
  masterWeight: number | null;
  lowThreshold: number | null;
  medThreshold: number | null;
  highThreshold: number | null;
  signer: { key: string; weight: number } | null;
} {
  const { masterWeight, lowThreshold, medThreshold, highThreshold, signer } = params;

  const thresholdFields: Record<string, number | undefined> = {
    masterWeight,
    lowThreshold,
    medThreshold,
    highThreshold,
  };

  for (const [field, value] of Object.entries(thresholdFields)) {
    if (value !== undefined) {
      if (!Number.isInteger(value) || value < 0 || value > 255) {
        throw new Error(`${field} must be an integer between 0 and 255`);
      }
    }
  }

  if (signer !== undefined) {
    if (!validateStellarAddress(signer.key)) {
      throw new Error('signer.key must be a valid Stellar address');
    }
    if (!Number.isInteger(signer.weight) || signer.weight < 0 || signer.weight > 255) {
      throw new Error('signer.weight must be an integer between 0 and 255');
    }
  }

  return {
    type: 'setOptions',
    masterWeight: masterWeight ?? null,
    lowThreshold: lowThreshold ?? null,
    medThreshold: medThreshold ?? null,
    highThreshold: highThreshold ?? null,
    signer: signer ?? null,
  };
}

// Convert decimal string to stroops (string of integer stroops)
export function toStellarAmount(decimalStr: Amount, decimals = 7): Stroops {
  // naive conversion: multiply decimal by 10^decimals
  const [whole, frac = ''] = decimalStr.split('.');
  const paddedFrac = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const stroops = BigInt(whole || '0') * BigInt(10 ** decimals) + BigInt(paddedFrac || '0');
  return stroops.toString();
}

export function fromStellarAmount(stroopsStr: Stroops, decimals = 7): Amount {
  const n = BigInt(stroopsStr);
  const whole = n / BigInt(10 ** decimals);
  const frac = (n % BigInt(10 ** decimals)).toString().padStart(decimals, '0').replace(/0+$/,'');
  return frac ? `${whole.toString()}.${frac}` : whole.toString();
}

export function formatAmount(amount: Stroops, decimals: number = 7): Amount {
  // Provided for backwards compatibility: expects stroops input
  try {
    return fromStellarAmount(amount, decimals);
  } catch {
    return amount;
  }
}

export function buildPaymentOperation(params: { source?: string; destination: string; asset: string; amount: Amount }){
  // Placeholder: return normalized operation object
  return {
    type: 'payment',
    source: params.source || null,
    destination: params.destination,
    asset: params.asset,
    amount: params.amount
  };
}
