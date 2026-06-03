require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const cookieParser = require("cookie-parser");

const countriesRouter = require("./routes/country");
const universityRouter = require("./routes/university");
const programRouter = require("./routes/programs");
const countryDetailRouter = require("./routes/countryDetail");
const authRouter = require("./routes/auth");
const profileRouter = require("./routes/userProfile");
const shortlistRouter = require("./routes/shortlist")
const searchRoutes = require("./routes/search");
const chatRouter = require("./routes/chat");
const adminRouter = require("./routes/admin");
const recommendRouter = require("./routes/recommend");


const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "https://fyp-univana.web.app" 
    ],
    credentials: true,
  })
);

app.use(express.json());
app.use(cookieParser());

// ✅ MongoDB connection
if (!process.env.MONGO_URI) {
  console.error("❌ MONGO_URI is missing");
  process.exit(1);
}

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Atlas connected"))
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err.message);
    process.exit(1);
  });

// Routes
app.use("/countries", countriesRouter);
app.use("/universities", universityRouter);
app.use("/programs", programRouter);
app.use("/countrydetails", countryDetailRouter);
app.use("/auth", authRouter);
app.use("/profile", profileRouter);
app.use("/shortlist",shortlistRouter)
app.use("/api/search", searchRoutes);
app.use("/api/chat", chatRouter);
app.use("/admin", adminRouter);
app.use("/api/recommend", recommendRouter);

// Start server (Railway-safe)
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});