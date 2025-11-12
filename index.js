// import { GoogleGenerativeAI } from "@google/generative-ai";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, ServerApiVersion, ObjectId } from "mongodb";
import { z, date } from "zod";
import admin from "firebase-admin";
import { GoogleGenAI } from "@google/genai";
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import { ca } from "zod/v4/locales";

// no need to read file
// const serviceAccount = JSON.parse(
//     fs.readFileSync(new URL("./serviceAccountKey.json", import.meta.url), "utf-8")
// );

dotenv.config()
const app = express();
const port = 5000;

app.use(express.json());
app.use(cors(['http://localhost:5173/']));

// const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
        }),
    });
};


const ai = new GoogleGenAI({});
async function generateQuestions(prompt) {
    const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
        config: {
            thinkingConfig: {
                thinkingBudget: 0, // Disables thinking
            },
        }
    });
    //   console.log(response.text);
    return response.text
};


// dompurify
const window = new JSDOM("").window;
const DOMPurify = createDOMPurify(window);


const Days = z.enum([
    "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"
]);

const HHMM = /^\d{2}:\d{2}$/;

const ClassCreateScheme = z.object({
    subject: z.string().min(1, "Subject is required").max(100),
    day: Days,
    startTime: z.string().regex(HHMM, "Start time must be HM:MM"),
    endTime: z.string().regex(HHMM, "endTime must be HH:MM"),
    instructor: z.string().min(1, "Instructor is required").max(100),
    color: z.string().regex(/^#([0-9A-Fa-f]{6})$/, "color must be hex"),
    userEmail: z.string().min(1, "user email is required")
}).refine((v) => v.startTime < v.endTime, {
    message: "startTime must be before endTIme",
    path: ["endTime"]
});

const classUpdateSchema = ClassCreateScheme.partial().refine((v) => {
    if (v.startTime && v.endTime) return v.startTime < v.endTime;
    return true
}, { message: "startTime must be before endTime", path: ["endTime"] });

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
        const classesCollection = db.collection("classes");
        const expensesCollection = db.collection("expenses");
        const budgetsCollection = db.collection("budgets");
        const notesCollection = db.collection("notes");

        // middlerwares

        const verifyToken = async (req, res, next) => {
            // req.user = null;
            const authHeader = req.headers?.authorization;
            if (!authHeader || !authHeader.startsWith("Bearer ")) {
                return res.status(401).send({ message: "unauthorized access" })
            }

            const token = authHeader.split(' ')[1];

            try {
                const decoded = await admin.auth().verifyIdToken(token);
                req.user = decoded
                // console.log(decoded)
                next()
            }
            catch (error) {
                console.log(error)
                return res.status(401).send({ message: "unauthorized access" })
            }
        };

        // for query parameter email verifications only
        const verifyEmail = async (req, res, next) => {
            const user = req?.user;
            if (!user) return null;
            if (user?.email !== req?.query?.email) {
                return res.status(403).send({ message: "Forbidden Access" })
            }
            next();
        };


        // gemini api
        app.post('/gemini', verifyToken, async (req, res) => {
            const { subject, subTopic, level, language } = req.body;

            console.log(req.body)
            const prompt = `generate 5 questions with answers on ${subject} at ${subTopic} and level ${level} subject or topic on ${language} language`;
            // console.log(sub)
            try {
                const result = await generateQuestions(prompt);
                // res.json({ reply: result.response.text() });
                res.send(result)
            } catch (error) {
                console.error("Gemini API error:", error);
                res.status(500).json({ error: "Failed to fetch response from Gemini API" });
            }
        });


        // USER RELATED API'S

        // insert user to database
        app.post("/user", async (req, res) => {
            const { user } = req.body;
            const email = user?.email;

            const isExist = await usersCollection.findOne({ email });
            if (isExist) {
                return res.status(400).send({ message: "User already Exist. Please login instead" })
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

        //  GET all classes
        app.get("/classes", verifyToken, verifyEmail, async (req, res) => {
            const { type, email } = req.query;

            const query = {};
            const now = new Date();
            // set query if user passes an email
            if (email) {
                query.userEmail = email
            }
            // console.log(now)

            // query based on type: next, prev, all
            if (type.toLowerCase() === "next") {
                query.endTime = { $gte: now };
            } else if (type === "prev") {
                query.endTime = { $lt: now };
            }


            const result = await classesCollection.find(query).sort({ startTime: 1 }).toArray();
            res.status(200).send(result);
        });

        app.post("/class", verifyToken, async (req, res) => {
            try {
                const { endTime, startTime, ...data } = req.body;
                const newStart = new Date(startTime);
                const newEnd = new Date(endTime);
                const userEmail = req.user.email;
                // 1. start time is after endtime or invalid time return 
                if (newStart >= newEnd) {
                    return res.status(400).send({ message: "End time can not be before start time" })
                }

                // 2. check if the class schedule overlaps
                const doesOverlap = await classesCollection.findOne({
                    userEmail,
                    $or: [
                        {
                            startTime: { $lt: newEnd },
                            endTime: { $gt: newStart }
                        }
                    ]
                });

                if (doesOverlap) {
                    return res.status(400).send({ message: "It overlaps with another class schedule" })
                }


                // 3. create and insert data
                const newData = {
                    ...data,
                    startTime: newStart,
                    endTime: newEnd,
                    createAt: new Date(),
                    userEmail
                };
                const result = await classesCollection.insertOne(newData);
                res.send(result)
            }
            catch (err) {
                if (err.errors) {
                    return res.status(400).send({ message: err.errors })
                }
                res.status(500).send({ message: "Internal server error" })
                console.log(err)
            }
            finally {
                // console.log('class api hitter')
            }
        });

        app.patch("/class/:id", verifyToken, async (req, res) => {
            // console.log('api hit')
            try {
                const { id } = req.params;
                const { startTime, endTime, ...clsData } = req.body;
                // const validatedData = classUpdateSchema.parse(req.body);
                const query = { _id: new ObjectId(id), userEmail: req.user.email };
                const updatedDoc = {
                    $set: {
                        ...clsData,
                        startTime: new Date(startTime),
                        endTime: new Date(endTime)
                    }
                };
                // console.log(clsData)

                const result = await classesCollection.updateOne(query, updatedDoc);
                if (result.matchedCount === 0) {
                    return res.status(403).json({ error: "Not authorized or class not found" });
                } res.send(result)
            }
            catch (err) {
                if (err.errors) {
                    return res.status(400).json({ errors: err.errors });
                }
                res.status(500).json({ error: "Internal Server Error" });
            }
        });

        app.delete("/class/:id", verifyToken, async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await classesCollection.deleteOne(query);
            res.send(result);
        });

        // expense related api
        app.post("/expense", verifyToken, async (req, res) => {
            try {
                const expense = req.body;
                const result = await expensesCollection.insertOne(expense);
                res.send(result)
            }
            catch (err) {
                console.log(err)
            }
        });

        // get expenses
        app.get("/expenses", verifyToken, async (req, res) => {
            const { budgetId } = req.query;
            const email = req.user.email;
            const query = { userEmail: email };
            if (budgetId) {
                query.budgetId = budgetId
            };

            const result = await expensesCollection.find(query).toArray();
            res.send(result)
        })

        // budget related api
        app.put("/budget", verifyToken, async (req, res) => {
            const { amount, userEmail, month } = req.body;
            if (!month || !userEmail || !amount) {
                return res.status(400).send({ message: "month, amount and userEmail are required" });
            }

            const filter = { userEmail, month };
            const updatedDoc = {
                $set: { amount, updatedAt: new Date() },
                $setOnInsert: { createdAt: new Date() }
            };
            const options = { upsert: true }

            // const result = await budgetsCollection.insertOne(data);
            const result = await budgetsCollection.updateOne(filter, updatedDoc, options)
            res.send(result)
        })

        // get a single budget of a user
        app.get("/budget", verifyToken, verifyEmail, async (req, res) => {
            const { email, month } = req.query;
            const query = {
                userEmail: email,
                month: month
            };
            // console.log(query)
            const result = await budgetsCollection.findOne(query);
            // console.log(result)
            res.send(result)
        })

        // get all budgets
        app.get("/budgets", async (req, res) => {
            const result = await budgetsCollection.find({}).toArray();
            res.send(result)
        });


        // notes realted api's

        app.get("/notes", async (req, res) => {
            const { email } = req.query;
            const query = { userEmail: email };
            const result = await notesCollection.find(query).toArray();
            res.send(result)
        });

        app.post("/note", verifyToken, async (req, res) => {
            try {
                const { content, title, subject } = req.body;
                const cleanHTML = DOMPurify.sanitize(content);
                const noteData = {
                    title,
                    subject,
                    content: cleanHTML,
                    userEmail: req.user.email,
                    createdAt: new Date()
                };

                const result = await notesCollection.insertOne(noteData);
                res.send(result)
            }
            catch (err) {
                console.log(err)
                return res.status(500).send({ message: "Internal error" })
            }
        });

        // delete a specific note
        app.delete("/note/:id", verifyToken, async (req, res) => {
            try {
                const { id } = req.params;
                const { email } = req.user;
                const query = {
                    _id: new ObjectId(id),
                    userEmail: email
                };
                const result = await notesCollection.deleteOne(query);
                if (result?.deletedCount > 0) {
                    res.send(result)
                } else {
                    res.status(404).send({ message: "Note not found" })
                }
            }
            catch (err) {
                console.log(err)
                res.status(500).send({ message: "Internal Server error" })
            }
        });

        app.get("/note/:id", verifyToken, async (req, res) => {
            try {
                const { id } = req.params;
                const query = {
                    _id: new ObjectId(id),
                    userEmail: req.user.email
                };
                const result = await notesCollection.findOne(query);
                res.send(result)
            } catch (err) {
                console.log(err)
                return res.status(500).send({ message: "internal server error" })
            }
        });

        app.patch("/note/:id", verifyToken, async (req, res) => {
            try {
                const { id } = req.params;
                const { content, title, subject } = req.body;
                const cleanContent = DOMPurify.sanitize(content);
                const query = {
                    _id: new ObjectId(id),
                    userEmail: req.user.email
                };
                const updatedDoc = {
                    $set: {
                        title,
                        subject,
                        content: cleanContent,
                        updatedAt: new Date()
                    }
                };
                const result = await notesCollection.updateOne(query, updatedDoc);
                res.send(result)
            } catch (err) {
                console.log(err)
                return res.status(500).send("Internal server error")
            }
        })

        // classesCollection.deleteMany()



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
    // console.log(`focus hub is running on port: ${port}`)
})