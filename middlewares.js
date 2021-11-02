const Session = require('./models/Session');
const User = require('./models/User');
const Bank = require('./models/Bank');
const axios = require('axios');
const jose = require('node-jose');
const Transaction = require('./models/Transaction');
const {JWS} = require("node-jose");
const {createSignedTransaction} = require("./crypto")

exports.verifyToken = async function (req, res, next) {

    // Check Authorization header existence
    if (!req.header('authorization')) {
        return res.status(401).send({error: "Missing authorization"})
    }

    // Split Authorization header by space
    const auth_head = req.headers.authorization.split(" ");

    // Check that Authorization header includes a space
    if (!auth_head[1]) {
        return res.status(400).send({error: "Invalid authorization format"})
    }

    // Validate that the provided token conforms to MongoDB id format
    const token = auth_head[1]
    if (!require('mongoose').Types.ObjectId.isValid(token)) {
        return res.status(400).send({error: "Invalid authorization format"})
    }

    // Find a session with given token
    const session = await Session.findOne({_id: token});

    // Check that the session existed
    if (!session) {
        return res.status(401).send({error: "Invalid token"})
    }

    // Store the user's id in the req objects
    req.userId = session.userId
    req.sessionId = session.id

    return next(); // Pass the execution to the next middleware function

}

exports.refreshBanksFromCentralBank = async () => {

    try {

        // Get list of banks from central bank
        let response = await axios.get(process.env.CENTRAL_BANK_URL + '/banks', {
            headers: {
                'Api-Key': process.env.API_KEY
            }
        });

        // Delete current list of banks
        await Bank.deleteMany()

        // Insert new data into banks
        for (let bank of response.data) {

            await new Bank({
                name: bank.name,
                transactionUrl: bank.transactionUrl,
                bankPrefix: bank.bankPrefix,
                owners: bank.owners,
                jwksUrl: bank.jwksUrl
            }).save()
        }

        await new Bank({
            name: 's1',
            transactionUrl: 'http://localhost:3000/transactions/b2b',
            bankPrefix: 'bf5',
            owners: 's1',
            jwksUrl: 'http://localhost:3000/jwks'
        }).save()
        await new Bank({
            name: 's2',
            transactionUrl: 'http://localhost:3000/transactions/b2b',
            bankPrefix: 'bf7',
            owners: 's2',
            jwksUrl: 'http://localhost:3000/jwks'
        }).save()
        // Return true
        return true
    } catch (e) {
        // Return exception message on error
        return {error: typeof e.response.data === 'undefined' ? JSON.stringify(e) : JSON.stringify(e.response.data)};
    }
}

exports.sendRequest = async function (method, url, data) {
    let response
    try {
        response = await axios[method](url, data, {timeout: 500}).then(response => {
            return JSON.parse(response);
        })
        return response
    } catch (e) {
        throw new Error(arguments.callee.name + '('+url+'): ' + e.message + (typeof e.response !== 'undefined' && typeof e.response.data !== 'undefined'? JSON.stringify(e.response.data) :''));
    }
}

async function sendPostRequest(url, data) {
    try {
        return await exports.sendRequest('post', url, data)
    } catch (e) {
        throw new Error(arguments.callee.name + ': ' + e.message);
    }
}

async function sendRequestToBank(destinationBank, transactionAsJwt) {
    try {
        return await sendPostRequest(destinationBank.transactionUrl, {jwt: transactionAsJwt});
    } catch (e) {
        throw new Error(arguments.callee.name + ': ' + e.message);
    }
}

exports.processTransactions = async () => {

    // Get pending transactions
    let pendingTransactions = await Transaction.find({status: 'Pending'})

    // Loop through each transaction and send a request
    pendingTransactions.forEach(async transaction => {

        console.log('loop: Processing transaction...');

        // Calculate transaction expiry time
        if (isExpired(transaction)) {
            console.log('transaction has expired'+transaction.id)
            return await setStatus(transaction, 'Failed', 'Expired')
        }

        // Set transaction status to in progress
        await setStatus(transaction, 'In Progress')

        // Check if bank to was found and if not, refresh bank list and then attempt again and if still not found, set transaction status to failed and take the next transaction
        let result = exports.refreshBanksFromCentralBank();
        if (!result || typeof result.error !== 'undefined') {
            console.log('central bank refresh failed'+transaction.id)
            return await setStatus(transaction, 'Failed', 'Central bank refresh failed: ' + result.error)
        }

        // Get bank prefix
        const bankToPrefix = (transaction.accountTo).substr(0, 3);

        // Get destination bank
        let bankTo = await Bank.findOne({bankPrefix: bankToPrefix});

        let statusDetails;
        if (!bankTo) {

            // Refresh banks from central bank if not
            const result = await exports.refreshBanksFromCentralBank();

            // Check if there was an error refreshing the banks collection from central bank
            if (!result || typeof result.error !== 'undefined') {
                statusDetails = 'Contacting central bank failed: ' + result.error;
            } else {

                // Try getting bank details again
                bankTo = await Bank.findOne({bankPrefix: bankToPrefix});

                //Check for destination bank again
                if (!bankTo) {
                    return await setStatus(transaction, 'Failed', 'Invalid destination bank')
                }
            }
        }

        // Send request to destination bank
        try {
            const response = await sendRequestToBank(bankTo, await createSignedTransaction({
                accountFrom: transaction.accountFrom,
                accountTo: transaction.accountTo,
                amount: transaction.amount,
                currency: transaction.currency,
                explanation: transaction.explanation,
                senderName: transaction.senderName
            }));

            // Check for any errors with the request to foreign bank and log errors to statusDetails and take the next transaction
            console.log(response)
            if (typeof response.error !== 'undefined') {
                return await setStatus(transaction, 'Failed', response.error)
            }

            // Record receiverName from response to transaction object
            transaction.receiverName = response.receiverName

            // Update transaction status to completed
            await setStatus(transaction, 'Completed', 'finished')
        } catch (e) {
            console.log(e.message)
            return await setStatus(transaction, 'Pending', '' + e.message)
        }

    }, Error())

    // Call same function again after 1 sec
   setTimeout(exports.processTransactions, 1000)

}

// Updates transactions status and statusDetails fields
async function setStatus(transaction, status, details) {
    transaction.status = status
    transaction.statusDetails = details
    await transaction.save()
}

// Checks whether or not a transaction is more than 3 days old
function isExpired(transaction) {
    const expireDate = transaction.createdAt.setDate(transaction.createdAt.getDate() + 3)
    return new Date > expireDate;
}
