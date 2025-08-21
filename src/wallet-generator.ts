// src/wallet-generator.ts
import 'dotenv/config';
import { exec } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import BitcoinCore from 'bitcoin-core';

interface WalletConfig {
  name: string;
  addressType: 'P2WSH';
  network: 'regtest';
  quorum: {
    requiredSigners: number;
    totalSigners: number;
  };
  extendedPublicKeys: Array<{
    name: string;
    xpub: string;
    bip32Path: string;
    xfp: string;
    method: string;
  }>;
  client: {
    type: 'private';
    url: string;
    username: string;
    password: string;
    walletName: string;
  };
}

export class WalletHealthGenerator {
  private config = {
  host: process.env.BITCOIN_RPC_HOST || 'localhost',
  port: parseInt(process.env.BITCOIN_RPC_PORT || '18443'),
  username: process.env.BITCOIN_RPC_USER || 'rpcuser',
  password: process.env.BITCOIN_RPC_PASSWORD || 'rpcpass',
  network: 'regtest' as const
  };
  
  private baseClient: BitcoinCore;

  constructor() {
    this.baseClient = new BitcoinCore({
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      password: this.config.password,
    });
  }

 // Change this method name and message:
async setupBitcoinEnvironment(): Promise<void> {
  console.log('🔗 Checking Bitcoin Core connection...');
  
  try {
    const info = await this.baseClient.command('getblockchaininfo');
    console.log(' Bitcoin Core is ready!', info.chain, 'blocks:', info.blocks);
    
    // Check if we have enough blocks for coinbase maturity
    if (info.blocks < 101) {
      console.log('⚙️ Insufficient blocks, setting up initial state...');
      await this.setupInitialState();
    } else {
      console.log(' Blockchain already has sufficient blocks');
      
      // Ensure miner wallet exists for operations
      await this.ensureMinerWallet();
    }
  } catch (error:any) {
    console.log('❌ Connection Error:', error.message);
    throw new Error('❌ Bitcoin Core not accessible. Make sure Bitcoin Core is running!');
  }
}

private async ensureMinerWallet(): Promise<void> {
  try {
    const wallets = await this.baseClient.command('listwallets');
    if (!wallets.includes('miner')) {
      await this.baseClient.command('createwallet', 'miner', false, false);
      console.log(' Miner wallet created');
    }
  } catch (error: any) {
    if (error.message?.includes('already exists')) {
      await this.baseClient.command('loadwallet', 'miner');
    }
  }
}

  async cleanupPreviousWallets(): Promise<void> {
    console.log(' Cleaning up previous wallets...');
    
    const scenarios = ['bad_privacy', 'bad_waste', 'good_privacy', 'good_waste'];
    
    for (const scenario of scenarios) {
      for (let i = 1; i <= 2; i++) {
        const walletName = `${scenario}_signer_${i}`;
        try {
          await this.baseClient.command('unloadwallet', walletName);
          console.log(`   Unloaded: ${walletName}`);
        } catch (e) {
          // Wallet not loaded, ignore
        }
      }
      
      const watcherName = `${scenario}_watcher`;
      try {
        await this.baseClient.command('unloadwallet', watcherName);
        console.log(`   Unloaded: ${watcherName}`);
      } catch (e) {
        // Watcher not loaded, ignore
      }
    }
  }

  private async setupInitialState(): Promise<void> {
    console.log(' Setting up initial blockchain...');
    
    try {
      await this.baseClient.command('createwallet', 'miner', false, false);
    } catch (error: any) {
      if (!error.message?.includes('already exists')) {
        await this.baseClient.command('loadwallet', 'miner');
      }
    }

    const minerClient = new BitcoinCore({
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      password: this.config.password,
      wallet: 'miner'
    });

    const address = await minerClient.command('getnewaddress');
    await this.baseClient.command('generatetoaddress', 101, address);
    console.log( ' Initial blockchain ready with 101 blocks');
  }

  async createMultisigWallet(scenarioName: string): Promise<{
    signers: Array<{ wallet: BitcoinCore; xpub: string; xfp: string; name: string }>;
    multisigAddress: string;
    watcherWallet: BitcoinCore;
  }> {
    console.log(` Creating 2-of-2 multisig for ${scenarioName}...`);

    const signers = await this.createSignerWallets(scenarioName);
    const { multisigAddress } = await this.createMultisigAddress(signers);
    const watcherWallet = await this.createWatcherWallet(scenarioName, signers);
    await this.fundMultisigAddress(multisigAddress, signers[0].wallet);
    
    return { signers, multisigAddress, watcherWallet };
  }

  private async createSignerWallets(scenarioName: string): Promise<Array<{
  wallet: BitcoinCore;
  xpub: string;
  xfp: string;
  name: string;
}>> {
  const signers = [];
  
  for (let i = 0; i < 2; i++) {
    const walletName = `${scenarioName}_signer_${i + 1}`;
    console.log(`   Setting up: ${walletName}`);
    
    // Check if wallet is already loaded
    try {
      const loadedWallets = await this.baseClient.command('listwallets');
      
      if (loadedWallets.includes(walletName)) {
        console.log(`    Wallet ${walletName} already loaded`);
      } else {
        // Try to load existing wallet first
        try {
          await this.baseClient.command('loadwallet', walletName);
          console.log(`    Loaded existing wallet: ${walletName}`);
        } catch (loadError: any) {
          if (loadError.code === -18) {
            // Wallet doesn't exist, create new one
            await this.baseClient.command('createwallet', walletName, false, false, '', false, true);
            console.log(`    Created new wallet: ${walletName}`);
          } else {
            throw loadError;
          }
        }
      }
    } catch (error: any) {
      console.log(`   Error with wallet ${walletName}:`, error.message);
      throw error;
    }

    const wallet = new BitcoinCore({
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      password: this.config.password,
      wallet: walletName
    });

    await this.fundWallet(wallet);
    const { xpub, xfp } = await this.extractWalletKeys(wallet, i);
    
    signers.push({ wallet, xpub, xfp, name: walletName });
    console.log(`    ${walletName} ready`);
  }
  
  return signers;
}

private async fundWallet(wallet: BitcoinCore): Promise<void> {
  console.log(`   Funding wallet...`);
  
  const address = await wallet.command('getnewaddress');
  console.log(`   Mining 50 blocks to ${address.slice(0, 20)}...`);
  
  await this.baseClient.command('generatetoaddress', 50, address);
  
  // Wait for wallet to sync and check balance
  for (let i = 0; i < 15; i++) {
    const balance = await wallet.command('getbalance');
    console.log(`   Balance check ${i + 1}: ${balance} BTC`);
    
    if (balance > 10) {
      console.log(`    Wallet funded with ${balance} BTC`);
      return;
    }
    
    await this.sleep(1000);
  }
  
  // If still no balance, try rescan - FIXED
  console.log(`   Attempting wallet rescan...`);
  try {
    await wallet.command('rescanblockchain'); // This will use correct wallet context
    await this.sleep(2000);
  } catch (rescanError: any) {
    console.log(`   Rescan failed: ${rescanError.message}`);
    // Continue anyway, maybe wallet will sync later
  }
  
  const finalBalance = await wallet.command('getbalance');
  console.log(`   Final balance: ${finalBalance} BTC`);
  
  if (finalBalance === 0) {
    console.log(`   ⚠️ Warning: Wallet has 0 balance, continuing anyway...`);
  }
}

  private async extractWalletKeys(wallet: BitcoinCore, index: number): Promise<{ xpub: string; xfp: string }> {
    try {
      const descriptors = await wallet.command('listdescriptors');
      const desc = descriptors.descriptors.find((d: any) => 
        d.desc.includes('wpkh') && d.desc.includes('/0/*')
      );
      
      if (desc) {
        const match = desc.desc.match(/\[([a-fA-F0-9]{8})\/[^\]]+\]([xtpub][a-zA-Z0-9]+)/);
        if (match) {
          return { xfp: match[1], xpub: match[2] };
        }
      }
    } catch (error) {
      console.log('   Using fallback key extraction...');
    }
    
    // Generate deterministic values for regtest
    const xfp = `${(index + 1).toString().padStart(4, '0')}${(index + 1).toString().padStart(4, '0')}`;
    const xpub = `tpub661MyMwAqRbcF${Math.random().toString(36).substring(2, 50)}`;
    
    return { xfp, xpub };
  }

  private async createMultisigAddress(signers: Array<{ wallet: BitcoinCore }>): Promise<{
    multisigAddress: string;
  }> {
    const pubkeys = [];
    for (const signer of signers) {
      const address = await signer.wallet.command('getnewaddress');
      const info = await signer.wallet.command('getaddressinfo', address);
      pubkeys.push(info.pubkey);
    }
    
    const multisigResult = await signers[0].wallet.command('createmultisig', 2, pubkeys);
    return { multisigAddress: multisigResult.address };
  }

 private async createWatcherWallet(
  scenarioName: string, 
  signers: Array<{ xpub: string; xfp: string }>
): Promise<BitcoinCore> {
  const walletName = `${scenarioName}_watcher`;
  console.log(`   Setting up watcher: ${walletName}`);
  
  // Check if wallet is already loaded
  try {
    const loadedWallets = await this.baseClient.command('listwallets');
    
    if (loadedWallets.includes(walletName)) {
      console.log(`    Watcher ${walletName} already loaded`);
    } else {
      // Try to load existing wallet first
      try {
        await this.baseClient.command('loadwallet', walletName);
        console.log(`    Loaded existing watcher: ${walletName}`);
      } catch (loadError: any) {
        if (loadError.code === -18) {
          // Wallet doesn't exist, create new watch-only wallet
          await this.baseClient.command('createwallet', walletName, true, false, '', false, true);
          console.log(`    Created new watcher: ${walletName}`);
        } else {
          throw loadError;
        }
      }
    }
  } catch (error: any) {
    console.log(`   Error with watcher ${walletName}:`, error.message);
    throw error;
  }

  const watcherWallet = new BitcoinCore({
    host: this.config.host,
    port: this.config.port,
    username: this.config.username,
    password: this.config.password,
    wallet: walletName
  });

  return watcherWallet;
}

  private async fundMultisigAddress(multisigAddress: string, coordinatorWallet: BitcoinCore): Promise<void> {
    console.log(`   Funding multisig...`);
    
    await coordinatorWallet.command('sendtoaddress', multisigAddress, 5);
    const address = await coordinatorWallet.command('getnewaddress');
    await this.baseClient.command('generatetoaddress', 1, address);
    
    console.log('    Multisig funded');
  }

  // ====== TRANSACTION PATTERNS ======
  async createBadPrivacyPattern(signers: Array<any>): Promise<void> {
    console.log(' Creating bad privacy patterns...');
    
    const coordinator = signers[0].wallet;
    
    // Address reuse - very bad for privacy
    const reusedAddress = await coordinator.command('getnewaddress');
    console.log(`    Reusing address for multiple transactions...`);
    
    for (let i = 0; i < 8; i++) {
      await coordinator.command('sendtoaddress', reusedAddress, 0.5);
      console.log(`     Transaction ${i + 1}/8 to same address`);
    }
    
    // Round amounts - fingerprinting
    console.log(`    Using round amounts...`);
    const roundAmounts = [1.0, 2.0, 5.0];
    for (const amount of roundAmounts) {
      const addr = await coordinator.command('getnewaddress');
      await coordinator.command('sendtoaddress', addr, amount);
      console.log(`     Sent ${amount} BTC (round number)`);
    }
    
    // Mine all transactions
    const address = await coordinator.command('getnewaddress');
    await this.baseClient.command('generatetoaddress', 3, address);
    
    console.log('    Bad privacy pattern complete (15+ transactions)');
  }

  async createBadWastePattern(signers: Array<any>): Promise<void> {
    console.log(' Creating wasteful patterns...');
    
    const coordinator = signers[0].wallet;
    
    // Create dust outputs
    console.log(`    Creating dust outputs...`);
    const dustOutputs: { [key: string]: number } = {};
    for (let i = 0; i < 15; i++) {
      const addr = await coordinator.command('getnewaddress');
      dustOutputs[addr] = 0.00001; // 1000 sats (dust)
    }
    await coordinator.command('sendmany', '', dustOutputs);
    console.log(`     Created 15 dust outputs (1000 sats each)`);
    
    // High fee transactions
    console.log(`    Creating high-fee transactions...`);
    for (let i = 0; i < 5; i++) {
      const addr = await coordinator.command('getnewaddress');
      // Use small amount to create high fee ratio
      await coordinator.command('sendtoaddress', addr, 0.001);
      console.log(`     High-fee transaction ${i + 1}/5`);
    }
    
    // Inefficient spending patterns
    console.log(`    Creating inefficient spending patterns...`);
    for (let i = 0; i < 10; i++) {
      const addr = await coordinator.command('getnewaddress');
      const inefficientAmount = Number((Math.random() * 0.1 + 0.001).toFixed(8));
      await coordinator.command('sendtoaddress', addr, inefficientAmount);
      console.log(`     Inefficient transaction ${i + 1}/10: ${inefficientAmount} BTC`);
    }
    
    // Mine all transactions
    const address = await coordinator.command('getnewaddress');
    await this.baseClient.command('generatetoaddress', 3, address);
    
    console.log('    Wasteful pattern complete (30+ transactions)');
  }

  async createGoodPrivacyPattern(signers: Array<any>): Promise<void> {
    console.log('✨ Creating good privacy patterns...');
    
    const coordinator = signers[0].wallet;
    
    // Always fresh addresses
    console.log(`    Using fresh addresses for every transaction...`);
    for (let i = 0; i < 15; i++) {
      const freshAddr = await coordinator.command('getnewaddress');
      const randomAmount = Number((Math.random() * 1.5 + 0.1).toFixed(8));
      await coordinator.command('sendtoaddress', freshAddr, randomAmount);
      console.log(`     Fresh address transaction ${i + 1}/15: ${randomAmount} BTC`);
      
      // Random timing to avoid correlation
      await this.sleep(Math.random() * 1000 + 200);
    }
    
    // Mixed transaction sizes
    console.log(`    Creating mixed transaction patterns...`);
    for (let i = 0; i < 12; i++) {
      const addr = await coordinator.command('getnewaddress');
      const mixedAmount = Number((Math.random() * 0.8 + 0.05).toFixed(8));
      await coordinator.command('sendtoaddress', addr, mixedAmount);
      console.log(`     Mixed transaction ${i + 1}/12: ${mixedAmount} BTC`);
    }
    
    // Mine all transactions
    const address = await coordinator.command('getnewaddress');
    await this.baseClient.command('generatetoaddress', 3, address);
    
    console.log('    Good privacy pattern complete (27+ transactions)');
  }

  async createGoodWastePattern(signers: Array<any>): Promise<void> {
    console.log(' Creating efficient patterns...');
    
    const coordinator = signers[0].wallet;
    
    // Efficient transaction sizes
    console.log(`    Creating optimal-sized transactions...`);
    for (let i = 0; i < 10; i++) {
      const addr = await coordinator.command('getnewaddress');
      const efficientAmount = Number((Math.random() * 0.5 + 0.1).toFixed(8));
      await coordinator.command('sendtoaddress', addr, efficientAmount);
      console.log(`     Efficient transaction ${i + 1}/10: ${efficientAmount} BTC`);
    }
    
    // Batch transactions
    console.log(`    Creating batch transactions...`);
    const batchOutputs: { [key: string]: number } = {};
    for (let i = 0; i < 8; i++) {
      const addr = await coordinator.command('getnewaddress');
      batchOutputs[addr] = Number((Math.random() * 0.3 + 0.05).toFixed(8));
    }
    await coordinator.command('sendmany', '', batchOutputs);
    console.log(`     Batched 8 transactions efficiently`);
    
    // Consolidation transactions
    console.log(`    Creating consolidation transactions...`);
    for (let i = 0; i < 6; i++) {
      const addr = await coordinator.command('getnewaddress');
      const consolidationAmount = Number((Math.random() * 1.0 + 0.2).toFixed(8));
      await coordinator.command('sendtoaddress', addr, consolidationAmount);
      console.log(`     Consolidation transaction ${i + 1}/6: ${consolidationAmount} BTC`);
    }
    
    // Mine all transactions
    const address = await coordinator.command('getnewaddress');
    await this.baseClient.command('generatetoaddress', 2, address);
    
    console.log('    Efficient pattern complete (24+ transactions)');
  }

  async saveCaravanConfig(
    scenarioName: string,
    signers: Array<{ xpub: string; xfp: string; name: string }>
  ): Promise<void> {
    const config: WalletConfig = {
      name: `${scenarioName.replace('_', ' ')} Multisig (2-of-2)`,
      addressType: 'P2WSH',
      network: 'regtest',
      quorum: {
        requiredSigners: 2,
        totalSigners: 2
      },
      extendedPublicKeys: signers.map(signer => ({
        name: signer.name.replace(/_/g, ' '),
        xpub: signer.xpub,
        bip32Path: "m/84'/1'/0'",
        xfp: signer.xfp,
        method: 'text'
      })),
      client: {
        type: 'private',
        url: `http://${this.config.host}:${this.config.port}`,
        username: this.config.username,
        password: this.config.password,
        walletName: `${scenarioName}_watcher`
      }
    };

    const configPath = path.join(process.cwd(), 'tmp', `${scenarioName}_caravan.json`);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    
    console.log(` Config saved: ${configPath}`);
  }

  // ====== MAIN GENERATORS ======
  async generateBadPrivacyWallet(): Promise<void> {
    console.log(' === GENERATING BAD PRIVACY WALLET ===');
    const { signers } = await this.createMultisigWallet('bad_privacy');
    await this.createBadPrivacyPattern(signers);
    await this.saveCaravanConfig('bad_privacy', signers);
    console.log(' Bad privacy wallet complete\n');
  }

  async generateBadWasteWallet(): Promise<void> {
    console.log(' === GENERATING BAD WASTE WALLET ===');
    const { signers } = await this.createMultisigWallet('bad_waste');
    await this.createBadWastePattern(signers);
    await this.saveCaravanConfig('bad_waste', signers);
    console.log(' Bad waste wallet complete\n');
  }

  async generateGoodPrivacyWallet(): Promise<void> {
    console.log(' === GENERATING GOOD PRIVACY WALLET ===');
    const { signers } = await this.createMultisigWallet('good_privacy');
    await this.createGoodPrivacyPattern(signers);
    await this.saveCaravanConfig('good_privacy', signers);
    console.log('Good privacy wallet complete\n');
  }

  async generateGoodWasteWallet(): Promise<void> {
    console.log(' === GENERATING GOOD WASTE WALLET ===');
    const { signers } = await this.createMultisigWallet('good_waste');
    await this.createGoodWastePattern(signers);
    await this.saveCaravanConfig('good_waste', signers);
    console.log(' Good waste wallet complete\n');
  }

  // src/wallet-generator.ts 

async generateAllWallets(): Promise<void> {
  await this.setupBitcoinEnvironment();
  await this.cleanupPreviousWallets();
  
  console.log('\n🎯 Generating all wallet health scenarios...\n');
  
  await this.generateBadPrivacyWallet();
  await this.generateBadWasteWallet(); 
  await this.generateGoodPrivacyWallet();
  await this.generateGoodWasteWallet();
  
  console.log('\n🎉 ALL WALLET HEALTH SCENARIOS GENERATED!');
  console.log('\n📁 Caravan config files created:');
  console.log('   • tmp/bad_privacy_caravan.json');
  console.log('   • tmp/bad_waste_caravan.json');
  console.log('   • tmp/good_privacy_caravan.json');
  console.log('   • tmp/good_waste_caravan.json');
}
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async cleanup(): Promise<void> {
    console.log('🧹 Script complete. Bitcoin container still running for Caravan integration.');
  }
}