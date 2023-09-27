import TigrisHelper from './lib/tigris.js';

class App {

    constructor() {
        this.tigris = new TigrisHelper("https://arb1.arbitrum.io/rpc");
        
        this.testTrade();
    }

    async testTrade() {

    }
}

async function main() {
    new App();
}

main().catch((error) => {
    console.error(error);
});