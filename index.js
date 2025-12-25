// import { GoogleGenerativeAI } from "@google/generative-ai";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, ServerApiVersion, ObjectId } from "mongodb";
import { z } from "zod";
import admin from "firebase-admin";
import { GoogleGenAI } from "@google/genai";
import sanitizeHtml from "sanitize-html";

// no need to read file
// const serviceAccount = JSON.parse(
//     fs.readFileSync(new URL("./serviceAccountKey.json", import.meta.url), "utf-8")
// );

dotenv.config()
const app = express();
const port = 5000;

app.use(express.json());
app.use(cors({
    origin: [
        'http://localhost:5173',
        'https://focus-hub-63922.web.app'
    ],
    credentials: true,
}));


// const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// firebase admin initialize
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
        }),
    });
};


const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
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
        // await client.connect();

        const db = client.db("focusHub");
        const usersCollection = db.collection("users");
        const classesCollection = db.collection("classes");
        const expensesCollection = db.collection("expenses");
        const budgetsCollection = db.collection("budgets");
        const notesCollection = db.collection("notes");
        const tasksCollection = db.collection("tasks");


        // creating indexes
        const createIndexes = async () => {
            try {
                await classesCollection.createIndex({
                    userEmail: 1,
                    startTime: 1,
                    endTime: 1
                });
                // console.log("Classes index created!");
            } catch (err) {
                console.error("Index creation failed:", err);
            }
        };

        // Call it after connecting MongoDB
        createIndexes();
        // const indexes = await classesCollection.indexes();
        // console.log(indexes);

        // middlewares

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
            if (!req.query.email) return null;
            if (user?.email !== req?.query?.email) {
                return res.status(403).send({ message: "Forbidden Access" })
            }
            next();
        };


        // gemini api
        app.post('/gemini', verifyToken, async (req, res) => {
            const { subject, subTopic, level, language } = req.body;

            // console.log(req.body)
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
            /* 
            NOTE --> 1. view has 2 values = flat and group
                     2. type has 2 values = next and prev
                     3. email is the value of the email from query email=.gmail.com
            */
            try {
                const {
                    view = 'flat',
                    type = 'next',
                    timezone = 'Asia/Dhaka',
                    email,
                    page = 1,
                    limit = 5
                } = req.query;
                console.log(limit)
                const now = new Date();
                let pageNum = parseInt(page);
                let pageLimit = parseInt(limit);
                pageNum = Number.isInteger(pageNum) && pageNum > 0 ? pageNum : 1;
                pageLimit = Number.isInteger(pageLimit) && pageLimit > 0 ? pageLimit : 5;
                const skip = (pageNum - 1) * pageLimit;
                const pipeline = [];
                const countPipeline = [];

                // STEP-1 -->   match the user with userEmail and compare it with now date to endTime property

                const matchStage = {
                    userEmail: email
                };

                // validate type query
                let order;
                const lowercaseType = type.toLowerCase();
                switch (lowercaseType) {
                    case "next":
                        // if the endTime is greater than current time setting query type=next will return it
                        matchStage.endTime = { $gte: now };
                        order = 1;

                        break;
                    case "prev":
                        matchStage.endTime = { $lt: now };
                        order = -1
                        break;
                    default:
                        return res.status(400).send({ message: "Invalid type query parameter" })
                }
                pipeline.push({ $match: matchStage })
                countPipeline.push({ $match: matchStage })
                // STEP-2 --> group every classes based on date using startTime property. date is defined as unique id
                // Get all supported IANA timezones
                const validTimezones = Intl.supportedValuesOf("timeZone");

                if (!validTimezones.includes(timezone)) {
                    // console.log(timezone)
                    return res.status(400).send({ message: "Invalid timezone" });
                }
                const dateGroup = {
                    $group: {
                        _id: {
                            // STEP-3I --> formatting date property
                            $dateToString: {
                                format: "%Y-%m-%d",
                                date: "$startTime",
                                timezone: timezone
                            }
                        },
                        // STEP-3II --> make array of classes for each date on startTime
                        classes: { $push: "$$ROOT" },
                        // STEP-3III --> get the total sum of classes held for each date
                        totalClasses: { $sum: 1 }
                    }
                }

                // STEP-4 -->  submit the result and as it is array convert it to array form json and use await

                // validate view
                const lowerCaseView = view.toLowerCase();
                switch (lowerCaseView) {
                    case "flat":
                        pipeline.push({ $sort: { startTime: order } });

                        pipeline.push(
                            { $skip: skip },
                            { $limit: pageLimit }
                        );
                        break;
                    case "group":
                        // pipeline.push(
                        //     dateGroup,
                        //     {
                        //         $project: {
                        //             _id: 0,
                        //             date: "$_id",
                        //             classes: 1,
                        //             totalClasses: 1
                        //         }
                        //     }
                        // );
                        pipeline.push(
                            dateGroup,
                            { $sort: { _id: order } }, // sort by date
                            { $skip: skip },       // paginate DATES
                            { $limit: pageLimit },
                            {
                                $project: {
                                    _id: 0,
                                    date: "$_id",
                                    classes: 1,
                                    totalClasses: 1
                                }
                            }
                        );
                        countPipeline.push(
                            dateGroup,
                        );
                        break;
                    default:
                        return res.status(400).send({ message: "Invalid view query parameter" })
                };

                countPipeline.push({ $count: "total" })

                const classes = await classesCollection.aggregate(pipeline).toArray();
                const countDoc = await classesCollection.aggregate(countPipeline).next();
                const totalDoc = countDoc?.total || 0;
                const totalPages = Math.ceil(totalDoc / pageLimit);
                // console.log()
                res.send({
                    view: lowerCaseView,
                    type: lowercaseType,
                    page: pageNum,
                    limit: pageLimit,
                    totalDoc,
                    totalPages,
                    classes: classes,
                });
            }
            catch (err) {
                console.log(err)
                res.status(500).send({ message: "Internal server error" })
            }
        });

        app.post("/class", verifyToken, async (req, res) => {
            try {
                const { endTime, startTime, date, ...data } = req.body;
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
                    date: new Date(date),
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


        // notes related api's

        app.get("/notes", verifyToken, verifyEmail, async (req, res) => {
            const { email, subject } = req.query;
            const query = { userEmail: email };
            // console.log(typeof subject)
            if (subject && subject.toLowerCase() !== "undefined" && subject.toLowerCase() !== "null") {
                if (subject.toLowerCase() !== "all") {
                    query.subject = subject;
                }
            }
            // console.log(query)
            const result = await notesCollection.find(query).toArray();
            res.send(result)
        });

        app.post("/note", verifyToken, async (req, res) => {
            try {
                const { content, title, subject } = req.body;
                const cleanHTML = sanitizeHtml(content, {
                    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img"]),
                    allowedAttributes: {
                        a: ["href", "name", "target"],
                        img: ["src", "alt"],
                        "*": ["style"],
                    },
                }); const noteData = {
                    title,
                    subject,
                    content: cleanHTML,
                    // content: content,
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
                // const cleanContent = DOMPurify.sanitize(content);
                const query = {
                    _id: new ObjectId(id),
                    userEmail: req.user.email
                };
                const updatedDoc = {
                    $set: {
                        title,
                        subject,
                        // content: cleanContent,
                        content: content,
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

        app.post("/task", verifyToken, async (req, res) => {
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
                const doesOverlap = await tasksCollection.findOne({
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
                const result = await tasksCollection.insertOne(newData);
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

        app.get("/tasks", verifyToken, verifyEmail, async (req, res) => {
            try {
                const { view = 'flat', type = 'next', timezone = 'Asia/Dhaka', email } = req.query;
                const now = new Date();
                const pipeline = [];

                pipeline.push({
                    $sort: { startTime: 1 }
                });

                const matchStage = {
                    userEmail: email
                };

                const lowercaseType = type?.toLowerCase();
                switch (lowercaseType) {
                    case "next":
                        // if the endTime is greater than current time setting query type=next will return it
                        matchStage.endTime = { $gte: now };
                        break;
                    case "prev":
                        matchStage.endTime = { $lt: now };
                        break;
                    default:
                        return res.status(400).send({ message: "Invalid type query parameter" })
                }
                pipeline.push({ $match: matchStage })

                const validTimezones = Intl.supportedValuesOf("timeZone");

                if (!validTimezones.includes(timezone)) {
                    return res.status(400).send({ message: "Invalid timezone" });
                }
                const dateGroup = {
                    $group: {
                        _id: {
                            // STEP-3I --> formatting date property
                            $dateToString: {
                                format: "%Y-%m-%d",
                                date: "$startTime",
                                timezone: timezone
                            }
                        },
                        // STEP-3II --> make array of classes for each date on startTime
                        tasks: { $push: "$$ROOT" },
                        // STEP-3III --> get the total sum of classes held for each date
                        totalTasks: { $sum: 1 }
                    }
                }

                const lowerCaseView = view.toLowerCase();
                switch (lowerCaseView) {
                    case "flat":
                        break;
                    case "group":
                        pipeline.push(
                            dateGroup,
                            {
                                $project: {
                                    _id: 0,
                                    date: "$_id",
                                    tasks: 1,
                                    totalTasks: 1
                                }
                            }
                        );
                        break;
                    default:
                        return res.status(400).send({ message: "Invalid view query parameter" })
                };

                const result = await tasksCollection.aggregate(pipeline).toArray();
                res.send({ tasks: result, view: lowerCaseView });
            } catch (err) {
                console.log(err)
                res.status(500).send({ message: "Internal server error" })
            }
        });

        app.patch("/task/:id", verifyToken, async (req, res) => {
            const { id } = req.params;
            const { startTime, endTime, ...task } = req.body;
            const query = {
                _id: new ObjectId(id),
                userEmail: req.user.email
            };
            const updatedDoc = {
                $set: {
                    ...task,
                    startTime: new Date(startTime),
                    endTime: new Date(endTime),
                    updateAt: new Date()
                }
            };
            const result = await tasksCollection.updateOne(query, updatedDoc);
            res.send(result)
        })

        app.delete("/task/:id", verifyToken, async (req, res) => {
            try {
                const { id } = req.params;
                const query = { _id: new ObjectId(id), userEmail: req.user.email };
                const result = await tasksCollection.deleteOne(query);
                res.send(result)
            } catch (err) {
                console.error(err)
                res.status(500).send({ message: "Internal server error" })
            }
        })

        // classesCollection.deleteMany()



        // Send a ping to confirm a successful connection
        // await client.db("admin").command({ ping: 1 });
        // console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);


app.get("/", (req, res) => {
    res.send(`Focus hub is Running`)
});

app.use((err, req, res, next) => {
    console.error("Unhandled error:", err);
    res.status(500).json({ error: "Something broke!" });
});

app.listen(port, () => {
    console.log(`focus hub is running on port: ${port}`)
})

// export default app