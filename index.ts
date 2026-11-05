import express, { Application, Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import { MongoClient, ServerApiVersion, ObjectId, Collection } from 'mongodb';
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

// Event type
type EventStatus = 'DRAFT' | 'PUBLISHED' | 'CLOSED';

interface EventDocument {
  title: string;
  description: string;
  date: Date;
  location: string;
  category: string;
  maxVolunteers: number;
  requiredSkills: string[];
  registrationDeadline: Date;
  organizerId: string;
  status: EventStatus;
  createdAt: Date;
  updatedAt: Date;
}

let eventsCollection: Collection<EventDocument>;

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

// Organizer Authorization
const requireOrganizer = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  if ((req as any).user?.role !== "ORGANIZER") {
    res.status(403).json({
      message: "Only organizers can perform this action.",
    });
    return;
  }
  next();
};

// Event Validation Helpers
const categories = [
  "Environment",
  "Education",
  "Healthcare",
  "Community",
  "Animal Welfare",
  "Other",
];

const isValidDate = (value: unknown): value is string => {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
};

const escapeRegex = (value: string): string => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

// ===============================
// ROUTES
// ===============================

// GET All Published Events
app.get("/api/events", async (req: Request, res: Response) => {
  try {
    const { category, search } = req.query;

    const filter: Record<string, unknown> = {
      status: "PUBLISHED",
    };

    if (typeof category === "string" && category !== "All") {
      filter.category = category;
    }

    if (typeof search === "string" && search.trim()) {
      const searchRegex = new RegExp(escapeRegex(search.trim()), "i");

      filter.$or = [
        { title: searchRegex },
        { description: searchRegex },
        { location: searchRegex },
      ];
    }

    const events = await eventsCollection
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).json({
      success: true,
      events,
    });
  } catch (error) {
    res.status(500).json({
      message: "Failed to fetch events.",
    });
  }
});

// GET Organizer's Events
app.get(
  "/api/events/my-events",
  verifyToken,
  requireOrganizer,
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;

      const events = await eventsCollection
        .find({ organizerId: user.id })
        .sort({ createdAt: -1 })
        .toArray();

      res.status(200).json({
        success: true,
        events,
      });
    } catch (error) {
      res.status(500).json({
        message: "Failed to fetch your events.",
      });
    }
  }
);

// GET Single Event
app.get("/api/events/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (typeof id !== 'string' || !ObjectId.isValid(id)) {
      res.status(400).json({ message: "Invalid event ID." });
      return;
    }

    const event = await eventsCollection.findOne({
      _id: new ObjectId(id),
      status: "PUBLISHED",
    });

    if (!event) {
      res.status(404).json({ message: "Event not found." });
      return;
    }

    res.status(200).json({
      success: true,
      event,
    });
  } catch (error) {
    res.status(500).json({
      message: "Failed to fetch event.",
    });
  }
});

// CREATE Event
app.post(
  "/api/events",
  verifyToken,
  requireOrganizer,
  async (req: Request, res: Response) => {
    try {
      const {
        title,
        description,
        date,
        location,
        category,
        maxVolunteers,
        requiredSkills,
        registrationDeadline,
        status = "PUBLISHED",
      } = req.body;

      if (
        !title?.trim() ||
        !description?.trim() ||
        !location?.trim() ||
        !category ||
        !isValidDate(date) ||
        !isValidDate(registrationDeadline) ||
        !Array.isArray(requiredSkills)
      ) {
        res.status(400).json({
          message: "Please provide all required event information.",
        });
        return;
      }

      if (!categories.includes(category)) {
        res.status(400).json({ message: "Invalid event category." });
        return;
      }

      if (
        !Number.isInteger(Number(maxVolunteers)) ||
        Number(maxVolunteers) < 1
      ) {
        res.status(400).json({
          message: "Maximum volunteers must be at least 1.",
        });
        return;
      }

      if (!["DRAFT", "PUBLISHED"].includes(status)) {
        res.status(400).json({ message: "Invalid event status." });
        return;
      }

      const eventDate = new Date(date);
      const deadlineDate = new Date(registrationDeadline);

      if (deadlineDate >= eventDate) {
        res.status(400).json({
          message: "Registration deadline must be before the event date.",
        });
        return;
      }

      const user = (req as any).user;

      const newEvent: EventDocument = {
        title: title.trim(),
        description: description.trim(),
        date: eventDate,
        location: location.trim(),
        category,
        maxVolunteers: Number(maxVolunteers),
        requiredSkills: requiredSkills
          .filter((skill: unknown) => typeof skill === "string")
          .map((skill: string) => skill.trim())
          .filter(Boolean),
        registrationDeadline: deadlineDate,
        organizerId: user.id,
        status,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await eventsCollection.insertOne(newEvent);

      res.status(201).json({
        success: true,
        message: "Event created successfully.",
        event: {
          ...newEvent,
          _id: result.insertedId,
        },
      });
    } catch (error) {
      res.status(500).json({
        message: "Failed to create event.",
      });
    }
  }
);

// UPDATE Event
app.patch(
  "/api/events/:id",
  verifyToken,
  requireOrganizer,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      if (typeof id !== 'string' || !ObjectId.isValid(id)) {
      res.status(400).json({ message: "Invalid event ID." });
      return;
    }

      const user = (req as any).user;

      const event = await eventsCollection.findOne({
        _id: new ObjectId(id),
      });

      if (!event) {
        res.status(404).json({ message: "Event not found." });
        return;
      }

      if (event.organizerId !== user.id) {
        res.status(403).json({
          message: "You can only update your own events.",
        });
        return;
      }

      const allowedFields = [
        "title",
        "description",
        "date",
        "location",
        "category",
        "maxVolunteers",
        "requiredSkills",
        "registrationDeadline",
        "status",
      ];

      const updates: Record<string, unknown> = {};

      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          updates[field] = req.body[field];
        }
      }

      if (Object.keys(updates).length === 0) {
        res.status(400).json({ message: "No valid fields provided." });
        return;
      }

      if (
        updates.title !== undefined &&
        (typeof updates.title !== "string" || !updates.title.trim())
      ) {
        res.status(400).json({ message: "Invalid event title." });
        return;
      }

      if (
        updates.description !== undefined &&
        (typeof updates.description !== "string" ||
          !updates.description.trim())
      ) {
        res.status(400).json({ message: "Invalid description." });
        return;
      }

      if (
        updates.category !== undefined &&
        (typeof updates.category !== "string" ||
          !categories.includes(updates.category))
      ) {
        res.status(400).json({ message: "Invalid event category." });
        return;
      }

      if (
        updates.date !== undefined &&
        !isValidDate(updates.date)
      ) {
        res.status(400).json({ message: "Invalid event date." });
        return;
      }

      if (
        updates.registrationDeadline !== undefined &&
        !isValidDate(updates.registrationDeadline)
      ) {
        res.status(400).json({ message: "Invalid registration deadline." });
        return;
      }

      if (
        updates.maxVolunteers !== undefined &&
        (!Number.isInteger(Number(updates.maxVolunteers)) ||
          Number(updates.maxVolunteers) < 1)
      ) {
        res.status(400).json({ message: "Invalid volunteer capacity." });
        return;
      }

      if (
        updates.requiredSkills !== undefined &&
        !Array.isArray(updates.requiredSkills)
      ) {
        res.status(400).json({ message: "Invalid required skills." });
        return;
      }

      if (
        updates.status !== undefined &&
        !["DRAFT", "PUBLISHED", "CLOSED"].includes(
          updates.status as string
        )
      ) {
        res.status(400).json({ message: "Invalid event status." });
        return;
      }

      if (typeof updates.title === "string") {
        updates.title = updates.title.trim();
      }

      if (typeof updates.description === "string") {
        updates.description = updates.description.trim();
      }

      if (typeof updates.location === "string") {
        if (!updates.location.trim()) {
          res.status(400).json({ message: "Invalid event location." });
          return;
        }
        updates.location = updates.location.trim();
      }

      if (updates.date !== undefined) {
        updates.date = new Date(updates.date as string);
      }

      if (updates.registrationDeadline !== undefined) {
        updates.registrationDeadline = new Date(
          updates.registrationDeadline as string
        );
      }

      if (updates.maxVolunteers !== undefined) {
        updates.maxVolunteers = Number(updates.maxVolunteers);
      }

      if (Array.isArray(updates.requiredSkills)) {
        updates.requiredSkills = updates.requiredSkills
          .filter((skill): skill is string => typeof skill === "string")
          .map((skill) => skill.trim())
          .filter(Boolean);
      }

      const resultingDate = (updates.date ?? event.date) as Date;
      const resultingDeadline = (
        updates.registrationDeadline ?? event.registrationDeadline
      ) as Date;

      if (resultingDeadline >= resultingDate) {
        res.status(400).json({
          message: "Registration deadline must be before the event date.",
        });
        return;
      }

      updates.updatedAt = new Date();

      const updatedEvent = await eventsCollection.findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $set: updates },
        { returnDocument: "after" }
      );

      res.status(200).json({
        success: true,
        message: "Event updated successfully.",
        event: updatedEvent,
      });
    } catch (error) {
      res.status(500).json({
        message: "Failed to update event.",
      });
    }
  }
);

// DELETE Event
app.delete(
  "/api/events/:id",
  verifyToken,
  requireOrganizer,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      if (typeof id !== 'string' || !ObjectId.isValid(id)) {
      res.status(400).json({ message: "Invalid event ID." });
      return;
    }

      const user = (req as any).user;

      const result = await eventsCollection.deleteOne({
        _id: new ObjectId(id),
        organizerId: user.id,
      });

      if (result.deletedCount === 0) {
        res.status(404).json({
          message: "Event not found or you are not the owner.",
        });
        return;
      }

      res.status(200).json({
        success: true,
        message: "Event deleted successfully.",
      });
    } catch (error) {
      res.status(500).json({
        message: "Failed to delete event.",
      });
    }
  }
);

app.get('/', (req: Request, res: Response) => {
    res.send('Server is running fine');
});

// Database Connection & Server Startup
async function startServer() {
    try {
        await client.connect();
        const db = client.db('community-volunteer-platform');
        eventsCollection = db.collection<EventDocument>("events");
        
        console.log("Pinged your deployment. You successfully connected to MongoDB!");

        app.listen(Number(PORT), () => {
            console.log(`Server running on port ${PORT}`);
        });
    } catch (error) {
        console.error("Failed to connect to MongoDB", error);
        process.exit(1);
    }
}

startServer();