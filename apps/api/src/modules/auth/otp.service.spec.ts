import { describe, expect, it } from 'vitest';

import { OtpService } from './otp.service';
import { maskPhone } from '../notifications/sms/mock-sms.provider';

describe('OtpService.generateCode', () => {
  it('produit exactement 6 chiffres', () => {
    for (let i = 0; i < 200; i++) {
      expect(OtpService.generateCode()).toMatch(/^\d{6}$/);
    }
  });

  it('comble les zeros de gauche', () => {
    // Sans remplissage, le code "42" donnerait 2 caracteres et
    // echouerait a la validation du schema.
    const codes = Array.from({ length: 500 }, () => OtpService.generateCode());

    expect(codes.every((code) => code.length === 6)).toBe(true);
  });

  it('reste dans la plage 000000-999999', () => {
    const codes = Array.from({ length: 500 }, () => Number(OtpService.generateCode()));

    expect(Math.min(...codes)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...codes)).toBeLessThanOrEqual(999_999);
  });

  it('ne produit pas toujours le meme code', () => {
    const codes = new Set(
      Array.from({ length: 200 }, () => OtpService.generateCode()),
    );

    // Un generateur defaussant produirait peu de valeurs distinctes.
    expect(codes.size).toBeGreaterThan(150);
  });
});

describe('maskPhone', () => {
  it('ne conserve que les quatre derniers chiffres', () => {
    // '+2250701234567' comporte 14 caracteres : 10 masques puis 4 chiffres.
    expect(maskPhone('+2250701234567')).toBe('**********4567');
  });

  it('masque un numero trop court', () => {
    expect(maskPhone('1234')).toBe('****');
    expect(maskPhone('12')).toBe('****');
  });

  it('ne laisse jamais paraitre plus de quatre caracteres', () => {
    expect(maskPhone('+2250701234567').replaceAll('*', '')).toHaveLength(4);
  });
});