const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion } = require('mongodb');
require('dotenv').config();
const app = express();
const port = 5000;

app.use(express.json());
app.use(cors(['http://localhost:5173/']));


const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.g8eto.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        await client.connect();

        const db = client.db("focusHub");
        const usersCollection = db.collection("users");
        // USER RELATED API'S

        // insert user to database
        app.post("/user", async (req, res) => {
            const { user } = req.body;
            const email = user?.email;

            const isExist = await usersCollection.findOne({email});
            if(isExist){
                return res.status(400).send({message: "User already Exist. Please login instead"})
            }

            const userData = {
                ...user,
                createdAt: new Date()
            };
            const result = await usersCollection.insertOne(userData);
            res.send(result)
        });

        app.get("/users", async (req, res) => {
            const result = await usersCollection.find({}).toArray();
            res.send(result)
        });



        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);



app.get("/", (req, res) => {
    res.send(`Focus hub is Running`)
});

app.listen(port, () => {
    console.log(`focus hub is running on port: ${port}`)
})