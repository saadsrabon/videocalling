import jwt from "jsonwebtoken";
import { config } from "../src/config/env.ts";

const userId = process.argv[2] ?? "user-a";

const token = jwt.sign({ sub: userId }, config.jwtSecret, {
  expiresIn: "1h",
  algorithm: "HS256",
});

console.log(token);
