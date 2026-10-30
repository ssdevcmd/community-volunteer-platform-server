import express, { Application, Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import { MongoClient, ServerApiVersion, ObjectId } from 'mongodb';
import { createRemoteJWKSet, jwtVerify } from 'jose-cjs';

dotenv.config();

const app: Application = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const uri = process.env.MONGO_URI as string;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

// Setup JWKS for token verification
const JWKS = createRemoteJWKSet(
    new URL(`${process.env.CLIENT_URL || 'http://localhost:3000'}/api/auth/jwks`)
);

// Token Verification Middleware
const verifyToken = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ message: 'Unauthorized' });
    }
    const token = authHeader.split(' ')[1];
    if (!token) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    try {
        const { payload } = await jwtVerify(token, JWKS);
        (req as any).user = payload;
        next();
    } catch (error) {
        return res.status(403).json({ message: 'Forbidden' });
    }
};

async function run() {
    try {
        await client.connect();

        const db = client.db('community-volunteer-platform');
        
        // Declare your collections here later:
        // const exampleCollection = db.collection('examples');

        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // await client.close();
    }
}
run().catch(console.dir);

app.get('/', (req: Request, res: Response) => {
    res.send('Server is running fine');
});

app.listen(Number(PORT), () => {
    console.log(`Server running on port ${PORT}`);
});