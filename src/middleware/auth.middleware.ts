// // auth/auth.middleware.ts
// import { Injectable, NestMiddleware } from '@nestjs/common';
// import { Request, Response, NextFunction } from 'express';
// import * as jwt from 'jsonwebtoken';
// import * as cookieParser from 'cookie-parser';

// @Injectable()
// export class AuthMiddleware implements NestMiddleware {
//   use(req: Request, res: Response, next: NextFunction) {
//     // Đảm bảo cookie-parser được sử dụng trong ứng dụng NestJS
//     cookieParser()(req, res, () => {});

//     const token = req.cookies['access_token']; // Lấy token từ cookie

//     if (!token) {
//       return res.status(401).json({ message: 'Unauthorized' });
//     }

//     try {
//       // Xác thực token bằng secret key
//       const decoded = jwt.verify(token, 'your-secret-key');  // Thay thế bằng secret thực tế
//       req.user = decoded;
//       next();
//     } catch (err) {
//       return res.status(401).json({ message: 'Unauthorized' });
//     }
//   }
// }
