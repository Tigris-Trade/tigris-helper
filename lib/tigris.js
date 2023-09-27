import { io } from "socket.io-client";
import fs from 'fs';
import { ethers, parseEther } from 'ethers';

export default class TigrisHelper {

    constructor(rpc) {
        this.rpc = rpc;

        /** Initiate addresses */
        this.initAddresses();
        /** Initiate oracle class */
        this.oracle = new Oracle();
        /** Initiate events */
        this.events = new Events();

        /** Reads ABIs */
        this.tradingABI = JSON.parse(fs.readFileSync('./abis/TradingContractABI.json', 'utf-8'));
        this.positionNFTABI = JSON.parse(fs.readFileSync('./abis/PositionNFTContractABI.json', 'utf-8'));

        /** Initiates positionNFT view contract */
        const provider = new ethers.JsonRpcProvider(this.rpc);
        this.positionNFT = new ethers.Contract(this.addresses.positionNFT, this.positionNFTABI, provider);
    }
    
    /**
     * Opens a trade
     * @param signer signer object
     * @param trade trade object {margin, leverage, pair, isLong}
     * @param trader trader address
     * @param sl [optional] stop loss price
     * @param tp [optional] take profit price
     * @returns true if success, error object if fail
     */
    async openTrade(signer, trade, trader, sl=0, tp=0) {
        const tradingContract = await this.createTradingContract(signer);

        const _tradeInfo = [
            parseEther(trade.margin.toString()),
            this.addresses.usdt,
            this.addresses.vault,
            parseEther(trade.leverage.toString()),
            trade.pair,
            trade.isLong,
            tp,
            sl,
            this.ref
        ];

        let priceData = [
            '0x0000000000000000000000000000000000000000',
            false,
            0,
            '0',
            0,
            '0',
            '0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'
        ]

        const p = await this.oracle.getPrice(trade.pair);
        if(p) {
            priceData = p;
        }

        try {
            await tradingContract.createMarketOrder(
                _tradeInfo,
                priceData,
                this.permit,
                trader
            );

            return true;
        } catch(e) {
            return e;
        }
    }

    /**
     * Closes a trade
     * @param signer signer object, needs to be the owner of the trade or an approved address
     * @param trader address of the trade owner
     * @param id trade NFT id
     * @param asset the asset id of the trade, optional but recommended
     * @returns true if success, error object if fail
     */
    async closeTrade(signer, id, trader, asset=-1) {
        const tradingContract = this.createTradingContract(signer);
        if(asset == -1) asset =  await this.getPositionAsset(id);
        const priceData = await this.oracle.getPrice(asset);
        if(!priceData[0]) return "!price data is not available";

        try {
            await tradingContract.initiateCloseOrder(
                id,
                10000000000, /** closes 100% of the position */
                priceData,
                this.addresses.vault,
                this.addresses.usdt,
                trader,
                {gasPrice: 1 * 1000000000, gas: 10000000000}
            );

            return true;
        } catch(e) {
            return e;
        }
    }

    /**
     * @param id the position nft id
     * @info returns the position asset's id
     */
    async getPositionAsset(id) {
        return parseInt((await this.positionNFT.trades(id))[2]);
    }

    /**
     * @param callback a function to be called when an event happens
     * @info callback function should take 2 parameters (eventName & eventObject)
     */
    async setEventsCallback(callback) {
        this.events.setTradingCallback(callback);
    }

    /**
     * Creates a trading contract instance
     * @param signer signer object
     * @returns trading contract
     */
    createTradingContract(signer) {
        return new ethers.Contract(this.addresses.trading, this.tradingABI, signer);
    }

    /**
     * Helper function to create a signer
     * @param privateKey Wallet private key
     * @returns a new signer
     */
    async createSigner(privateKey) {
        return new ethers.Wallet(privateKey, new ethers.JsonRpcProvider(this.rpc));
    }

    /**
     * Sets referral address
     * @param _ref address that earns ref fees
     */
    setRef(_ref) {
        this.ref = _ref;
    }

    /**
     * Initiates addresses
     */
    async initAddresses() {
        this.addresses = {
            trading: "0x399214eE22bF068ff207adA462EC45046468B766",
            usdt: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
            vault: "0xe82fcefbDD034500B5862B4827CAE5c117f6b921",
            positionNFT: "0x09D74999e5315044956ad15D5F2Aeb8d393E85eD"
        }

        this.permit = [0, 0, 0, '0x0000000000000000000000000000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000000000000000000000000000', false];
        this.ref = "0x0000000000000000000000000000000000000000";
    }
}


/**
 * A class that connects to Tigris price oracle and prepares 
 * the the signed prices for transactions.
 */
class Oracle {
    constructor() {
        const socket = io.connect("wss://eu1.tigrisoracle.net", { transports: ['websocket'] });

        socket.on('connect', () => {
            /* console.log('Connected to Tigris Oracle'); */
        });

        socket.on('data', (d) => {
            this.data = d;
        });

        socket.on('error', (err) => {
            console.log(err);
        });
    }

    /**
     * Prepares the signed prices that are ready to be included in the transacions
     * @returns An array that contains prepared signed price of all assets
     */
    async getPrices() {
        if(!this.data) return false;
        let allData = [];

        for(let i=0; i < this.data.length; i++) {
            let data = await this.data[i];

            allData.push([
                data?.provider,
                data?.is_closed,
                data?.asset,
                data?.price,
                data?.spread,
                data?.timestamp,
                data?.signature
            ]);
        }

        return allData;
    }

    /**
     * Prepares the signed price by id that is ready to be included in the transacions
     * @returns An array that contains the signed price of the asset id
     */
    async getPrice(id) {
        if(!this.data) return false;
        let data = await this.data[id];

        return [
            data?.provider,
            data?.is_closed,
            data?.asset,
            data?.price,
            data?.spread,
            data?.timestamp,
            data?.signature
        ];
    }
}

/**
 * A class that connects to Tigris events websocket.
 */
class Events {
    constructor() {
        this.socket = io.connect(new Date().getTimezoneOffset() < -120 ? 'https://us1events.tigristrade.info' : 'https://eu1events.tigristrade.info', { transports: ['websocket'] });

        this.socket.on('connect', () => {
            /* console.log('Connected to Tigris Events'); */
        });

        this.socket.on('error', (error) => {
            console.log('Events Socket Error:', error);
        });
    }

    /**
     * 
     * @param callback a function to be called when an event happens
     * @info callback function should take 2 parameters (eventName & eventObject)
     */
    async setTradingCallback(callback) {
        /** gives time to socket to connect */
        if (!this.socket.connected) await new Promise(r => setTimeout(r, 5*1000));

        this.socket.on('PositionOpened', (event) => {
            /**
             * PositionOpened event object example:
             * {
                    chainId,
                    tradeInfo: {
                        margin,
                        marginAsset,
                        stableVault,
                        leverage,
                        asset,
                        direction,
                        tpPrice,
                        slPrice,
                        referrer,
                    },
                    orderType,
                    price, 
                    id,
                    trader,
                    marginAfterFees,
                    orderId
                }
             */

            callback("PositionOpened", event);
        });

        this.socket.on('PositionClosed', (event) => {
            /**
             * PositionClosed event object example:
             * {
                    chainId,
                    id,
                    closePrice,
                    percent,
                    payout,
                    trader,
                    executor
                }
             */

            callback("TradeClosed", event);
        });

        this.socket.on('PositionLiquidated', (event) => {
            /**
             * PositionLiquidated event object example:
             * {
                    chainId,
                    id,
                    liqPrice,
                    trader,
                    executor
                }
             */

            callback("PositionLiquidated", event);
        });

        this.socket.on('LimitOrderExecuted', (event) => {
            /**
             * LimitOrderExecuted event object example:
             * {
                    chainId,
                    asset,
                    direction,
                    openPrice,
                    lev,
                    margin,
                    id,
                    trader,
                    executor
                }
             */

            callback("LimitOrderExecuted", event);
        });

        this.socket.on('UpdateTPSL', (event) => {
            /**
             * UpdateTPSL event object example:
             * {
                    chainId,
                    id,
                    isTp,
                    price,
                    trader
                }
             */

            callback("UpdateTPSL", event);
        });

        this.socket.on('LimitCancelled', (event) => {
            /**
             * LimitCancelled event object example:
             * {
                    chainId,
                    id,
                    trader
                }
             */

            callback("LimitCancelled", event);
        });

        this.socket.on('MarginModified', (event) => {
            /**
             * MarginModified event object example:
             * {
                    chainId,
                    id,
                    newMargin,
                    newLeverage,
                    isMarginAdded,
                    trader
                }
             */

            callback("MarginModified", event);
        });

        this.socket.on('AddToPosition', (event) => {
            /**
             * AddToPosition event object example:
             * {
                    chainId,
                    id,
                    newMargin,
                    newPrice,
                    addMargin,
                    trader,
                    orderId
                }
             */

            callback("AddToPosition", event);
        });
    }
}
