// src/index.ts
import { WalletHealthGenerator } from './wallet-generator.js';

const BANNER = `
╔═══════════════════════════════════════╗
║  🔗 Caravan Wallet Health Generator   ║
║  Generates test wallets for Caravan   ║
╚═══════════════════════════════════════╝
`;

async function main() {
  console.log(BANNER);
  
  const generator = new WalletHealthGenerator();
  
  try {
    console.log(' Starting wallet generation...');
    
    const startTime = Date.now();
    await generator.generateAllWallets();
    const endTime = Date.now();
    
    const duration = ((endTime - startTime) / 1000).toFixed(2);
    console.log(` Total time: ${duration} seconds`);
    
  } catch (error) {
    console.error('\n❌ Generation failed:', error);
    await generator.cleanup();
    process.exit(1);
  }
}

process.on('SIGINT', async () => {
  console.log(' Shutting down...');
  process.exit(0);
});

main().catch(console.error);