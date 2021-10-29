const mongoose = require('mongoose')

//Describe transactions collection
module.exports = mongoose.model('Transaction', new mongoose.Schema({
    accountFrom: {type: String, required: true},
    accountTo: {type: String, required: true},
    amount: {type: Number, unique: false, required: true},
    currency: {type: String, required: true},
    explanation: {type: String, required: true},
    status: {type: String, enum: ['Pending', 'Completed', 'Failed', 'In Progress'], default: 'Pending'},
    statusDetails: {type: String, default: ''},
    senderName: {type: String, default: ''},
    createdAt: {type: Date, default:Date.now},
    receiverName: {type: String, default: ''}
}, {
    toJSON: {
        transform: function (doc, ret) {
            delete ret._id;
            delete ret.__v;
        }
    }
}));