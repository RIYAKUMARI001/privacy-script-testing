declare module 'bitcoin-core' {
  interface BitcoinCoreOptions {
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    wallet?: string;
    network?: string;
  }

  class BitcoinCore {
    constructor(options: BitcoinCoreOptions);
    command(method: string, ...params: any[]): Promise<any>;
  }

  export = BitcoinCore;
}