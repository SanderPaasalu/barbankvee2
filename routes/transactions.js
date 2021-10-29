// Pull in dependencies
const router = require('express').Router();
const Account = require('../models/Account');
const Transaction = require('../models/Transaction');
const Bank = require('../models/Bank');
const {verifyToken, refreshBanksFromCentralBank} = require("../middlewares");
const {JWK, JWS} = require('node-jose')
const {join} = require('path')
const {verifySignature, getPublicKey} = require("../crypto")
const base64url = require('base64url');
const fs = require("fs");
const Buffer = require('buffer/').Buffer;

// Handle POST /transactions
module.exports = router.post('/', verifyToken, async (req, res) => {

    try { //Retrieve account from mongo by account number
        const accountFrom = await Account.findOne({account_number: req.body.accountFrom});
        //Retrieve receiver from mongo by account number
        const accountTo = await Account.findOne({account_number: req.body.accountTo});

        // Return status 404 on invalid account
        if (!accountFrom) {
            return res.status(404).send({error: 'Nonexistent accountFrom'});
        }

        // 403 - Forbidden
        if (accountFrom.userId.toString() !== req.userId.toString()) {
            return res.status(403).send({error: 'Forbidden accountFrom'});
        }

        // Return 422 on insufficient funds
        if (accountFrom.balance < req.body.amount) {
            return res.status(402).send({error: 'Insufficient funds'});
        }

        // Return status 400 on invalid amount
        if (req.body.amount < 0) {
            return res.status(400).send({error: 'Invalid amount'});
        }

        // Get bank prefix
        const bankToPrefix = (req.body.accountTo).substr(0, 3);

        // Get destination bank
        let bankTo = await Bank.findOne({bankPrefix: bankToPrefix});

        // Init statusDetails outside of if
        let statusDetails = '';

        // Check if destination bank existed locally
        if (!bankTo) {

            // Refresh banks from central bank if not
            const result = await refreshBanksFromCentralBank();

            // Check if there was an error refreshing the banks collection from central bank
            if (!result || typeof result.error !== 'undefined') {
                statusDetails = 'Contacting central bank failed: ' + result.error;
            } else {

                // Try getting bank details again
                bankTo = await Bank.findOne({bankPrefix: bankToPrefix});

                //Check for destination bank again
                if (!bankTo) {
                    return res.status(404).send({"error": "Destination bank not found"})
                }
            }
        }

        // Create transaction into database.
        await new Transaction({
            accountFrom: req.body.accountFrom,
            accountTo: req.body.accountTo,
            amount: req.body.amount,
            currency: accountFrom.currency,
            explanation: req.body.explanation,
            statusDetails: statusDetails
        }).save();

        await debitAccount(accountFrom, req.body.amount);

        // 201 - Created
        return res.status(201).end();
    } catch (e) {

        // 400 Parameter(s) missing
        if (/Transaction validation failed:/.test(e.message)) {
            return res.status(400).send({error: e.message})
        }

        // 500 Unknown error
        return res.status(500).send({error: e.message})
    }
});

// Yoinks money
async function debitAccount(account, amount) {
    account.balance -= amount
    await account.save();
}

// Plonks money
async function creditAccount(account, amount) {
    account.balance += amount
    await account.save();
}

router.get('/jwks', async function (req, res) {

    // Add our private key from file to the keystore
    console.log('/jwks: Reading keystore from json file into memory')
    const keystoreAsJsonString = fs.readFileSync(join('.cert', 'keystore.json')).toString();
    const keystore = await JWK.asKeyStore(keystoreAsJsonString)

    // Return our keystore (only the public key derived from the imported private key) in JWKS (JSON Web Key Set) format
    console.log('/jwks: Returning keystore without private key')

    return res.send(keystore.toJSON())
})

async function convertCurrency(payload, accountTo) {
    let amount = payload.amount
    if (accountTo.currency !== payload.currency) {
        const rate = await getRates(payload.currency, accountTo.currency)
        amount = parseInt((parseInt(amount) * parseFloat(rate)).toFixed(0))
    }

    return amount;
}

router.post('/b2b', async function (req, res) {
    try {
        const components = req.body.jwt.split('.')
        const payload = JSON.parse(base64url.decode(components[1]))
        const accountTo = await Account.findOne({number: payload.accountTo})
    } catch (e) {

        // 500 - Internal server error
        return res.status(500).send({error: e.message})
    }

    // Get source bank prefix
    ["accountFrom", "accountTo", "amount", "currency", "explanation", "senderName"].forEach(function (parameter) {
        if (!payload[parameter]) {
            return res.status(400).send({error: 'Missing parameter ' + parameter + ' in JWT'})
        }
        if (typeof payload[parameter] !== 'string') {
            return res.status(400).send({error: parameter + ' is of type ' + typeof payload[parameter] + ' but expected it to be type string in JWT'})
        }
    })

    const accountFromBankPrefix = payload.accountFrom.substring(0, 3)

    // Find source bank (document)
    let accountFromBank = await Bank.findOne({bankPrefix: accountFromBankPrefix})

    if (!accountFromBank) {

        // Refresh the local list of banks with the list of banks from the central bank - kinda long but eh
        const result = await refreshBanksFromCentralBank();
        if (typeof result.error !== 'undefined') {

            // 500
            return res.status(500).send({error: "refreshBanksFromCentralBank: " + result.error}) //
        }

        // Find source bank (document)
        accountFromBank = await Bank.findOne({bankPrefix: accountFromBankPrefix})

        if (typeof result.error !== 'undefined') {

            // 400
            return res.status(400).send({error: "Unknown sending bank"}) //
        }
    }

    // Validate signature
    try {
        const publicKey = await getPublicKey(accountFromBank.jwksUrl)
        await verifySignature(req.body.jwt, publicKey);
    } catch (e) {

        // 400 - Bad request
        return res.status(400).send({error: 'Signature verification failed: ' + e.message})
    }

    let amount = await convertCurrency(payload, accountTo)

    const accountToOwner = await User.findOne({_id: accountTo.userId})

    //money laundering
    await creditAccount(accountTo, req.body.amount)
})