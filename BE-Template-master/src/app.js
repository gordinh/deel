const express = require('express');
const bodyParser = require('body-parser');
const {sequelize} = require('./model');
const {getProfile} = require('./middleware/getProfile');
const { Op, where } = require('sequelize');

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
    extended: true
  }));
app.set('sequelize', sequelize);
app.set('models', sequelize.models);

/**
 * FIX ME!
 * @returns contract by id
 */
 app.get('/contracts/:id', getProfile, async (req, res) => {
    const { Contract } = req.app.get('models');
    const { id } = req.params;
    const profileId = req.get('profile_id');
    let where = {
        [Op.or]: {
            ClientId: profileId,
            ContractorId: profileId
        },
        [Op.and]: {
            id: id
        }
    };
    const contract = await Contract.findOne({where: where});
    if(!contract) return res.status(404).end();
    res.json(contract);
})


app.get('/contracts/', getProfile, async (req, res) => {
    const {Contract} = req.app.get('models');
    const {id} = req.params;
    const profileId = req.get('profile_id');
    let where = {
        [Op.or]: {
            ClientId: profileId,
            ContractorId: profileId
        },
        status: {
            [Op.ne]: 'terminated'
        }
    };
    const contract = await Contract.findAll({where: where});
    if(!contract) return res.status(404).end();
    res.json(contract);
})

app.get('/jobs/unpaid', getProfile, async (req, res) => {
    const { Job, Contract } = req.app.get('models');
    const profileId = req.get('profile_id');
    let where = {
        paid: {
            [Op.or]: [ null, false]    
        }  
    };
    let include = [{
        model: Contract,
        where: {
            [Op.or]: {
                ClientId: profileId,
                ContractorId: profileId
            },
            status: {
                [Op.eq]: 'in_progress'
            }            
        },
        required: true
    }]
    const job = await Job.findAll({ where: where, include: include})

    if(!job) return res.status(404).end();
    res.json(job);
})


// Pay for a job, a client can only pay if his balance >= the amount to pay.
//  The amount should be moved from the client's balance to the contractor balance.
app.post('/jobs/:job_id/pay', getProfile, async (req, res) => {
    const { Job, Contract, Profile } = req.app.get('models');
    const { job_id } = req.params;
    const profileId = req.get('profile_id');

    const whereContract = {
        [Op.or]: {
            ClientId: profileId,
            ContractorId: profileId
        }
    }

    const whereJob = {
        id: {
            [Op.eq]: job_id
        }
    }

    const includeContract = {
        model: Contract,
        where: {
            [Op.or]: {
                ClientId: profileId,
                ContractorId: profileId
            }           
        },
        required: true
    }

    const job = await Job.findOne({ include: includeContract, where: whereJob });
    const contract = await Contract.findOne({ where: whereContract});

    if (!job) {
        res.status(404);
        res.send("Job/Profile id not found").end();
    } else if (job.paid) {
        res.status(403);
        return res.send('Job has already being paid').end();
    } else if (!contract) {
        res.status(403);
        return res.send('Profile id doesn\'t belong to job_id').end();
    } else if (profileId == job.Contract.ContractorId) {
        res.status(403);
        return res.send('Only client profile is allowed to pay for job').end();
    } else {
        const contractor = await Profile.findByPk(job.Contract.ContractorId);
        const client = await Profile.findByPk(job.Contract.ClientId);
    
        // Validating balance
    
        if (client.balance >= job.price) {
            // Transfer funds from client
            const newClientBalance = client.balance - job.price;
            await Profile.update({ balance: newClientBalance }, {
                where: { id: client.id }
            });
    
            // Transfer funds to contractor
            const newContractorBalance = contractor.balance + job.price;
            await Profile.update({ balance: newContractorBalance }, {
                where: { id: contractor.id }
            })
    
            // Update Contract
            await Contract.update({ status: 'terminated' }, {
                where: { id: contract.id }
            })
    
            // Update Job
            await Job.update({ paid: true, paymentDate: Date.now() }, {
                where: { id: job_id}
            })
        } else {
            res.status(403);
            res.send('Insufficient account amount for payment!')
        }
    
        res.status(200).end();
    }
    
});

// Deposits money into the the the balance of a client, 
// a client can't deposit more than 25% his total of jobs to pay. (at the deposit moment)
app.post('/balances/deposit/:userId', getProfile, async (req, res) => {
    const { Job, Profile, Contract } = req.app.get('models');
    const { userId } = req.params;
    const { deposit } = req.body;
    const profileId = req.get('profile_id');

    const job = await sequelize.query(`SELECT SUM(Jobs.price) as total FROM Jobs INNER JOIN Contracts c ON c.id = Jobs.ContractId 
        WHERE c.ClientId = ${userId} and paid is null or paid = 0`)
    // const contract = await Contract.findOne({ where: whereContract});

    const depositThreeshold = 0.25 * job[0][0].total

    if (deposit > depositThreeshold) {
        res.status(403);
        return res.send(`Client can\'t deposite more than 25% of his total of jobs to pay (${depositThreeshold})`).end();
    } else if (userId != profileId) {
        res.status(403);
        return res.send(`Client can\'t deposite values to another client`).end();     
    } else {
        const client = await Profile.findByPk(userId);
        const newBalance = parseFloat(client.balance) + parseFloat(deposit);
        console.log(newBalance)

        await Profile.update({ balance: parseFloat(newBalance) }, {
            where: { id: userId }
        });
        return res.status(200).end();
    }
});

// Returns the profession that earned the most money (sum of jobs paid) 
// for any contactor that worked in the query time range.
app.get('/admin/best-profession', getProfile, async (req, res) => {
    const { start, end } = req.query;
    const bestProfession = await sequelize.query(`
    SELECT p.profession as profession, SUM(j.price) as total FROM Profiles p 
        JOIN Contracts c ON c.ContractorId = p.id
        JOIN Jobs j ON j.ContractId = c.id 
    WHERE j.paymentDate between \'${start}\' and \'${end}\'
    GROUP BY p.profession 
    ORDER BY total DESC 
    LIMIT 1;
    `)
    if(!bestProfession[0].length) return res.status(404).end();
    res.status(200);
    res.json(bestProfession[0][0])
})

// returns the clients the paid the most for jobs in the query time 
// period. limit query parameter should be applied, default limit is 2.
// start=<date>&end=<date>&limit=<integer>`
app.get('/admin/best-clients', getProfile, async (req, res) => {
    const { Job, Contract, Profile } = req.app.get('models');
    const { start, end } = req.query;
    const limit = req.query.limit ? req.query.limit : 2;
    const bestClients = await sequelize.query(`
    SELECT p.id as id, (p.firstName || ' ' || p.lastName) as fullName, SUM(j.price) as paid
    FROM Profiles p 
        JOIN Contracts c ON c.ClientId = p.id
        JOIN Jobs j ON j.ContractId = c.id 
    WHERE j.paymentDate between \'${start}\' and \'${end}\' and j.paid = 1
    GROUP BY c.ClientId
    ORDER BY paid DESC 
    LIMIT ${limit};
    `)

    if(!bestClients[0].length) return res.status(404).end();
    res.status(200);
    res.json(bestClients[0])
})

module.exports = app;
