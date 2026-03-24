import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bip39 from 'bip39';
import { BIP32Factory } from 'bip32';
import * as ecc from 'tiny-secp256k1';
import { payments } from 'bitcoinjs-lib';

const bip32 = BIP32Factory(ecc);

@Injectable()
export class BtcIdentifierService {
  private getSeedPhrase(): string {
    const phrase = this.configService.get<string>('SEED_PHRASE', '').trim();
    if (!phrase) {
      throw new InternalServerErrorException('SEED_PHRASE is not configured');
    }
    if (!bip39.validateMnemonic(phrase)) {
      throw new InternalServerErrorException(
        'SEED_PHRASE must be a valid BIP39 mnemonic',
      );
    }
    return phrase;
  }

  constructor(private readonly configService: ConfigService) {}

  validateConfig(): void {
    this.getSeedPhrase();
  }

  /**
   * Split uid to avoid a large final index in the path.
   * Example: uid=987 => branch=98, index=7.
   */
  private splitUid(uid: number): { branch: number; index: number } {
    if (!Number.isInteger(uid) || uid < 0) {
      throw new InternalServerErrorException('uid must be a positive integer');
    }
    return {
      branch: Math.floor(uid / 10),
      index: uid % 10,
    };
  }

  /**
   * Derive BTC p2pkh identifier at:
   * m/44'/0'/0'/{branch}/{index}
   * where uid=987 => branch/index = 98/7
   */
  async deriveIdentifierByUid(uid: number): Promise<string> {
    const { branch, index } = this.splitUid(uid);
    const phrase = this.getSeedPhrase();
    const seed = await bip39.mnemonicToSeed(phrase);
    const root = bip32.fromSeed(seed);
    const child = root.derivePath(`m/44'/0'/0'/${branch}/${index}`);
    const pubkey = Buffer.from(child.publicKey);
    const { address } = payments.p2pkh({ pubkey });
    if (!address) {
      throw new InternalServerErrorException(
        'Unable to derive BTC identifier from seed phrase',
      );
    }
    return address;
  }
}
