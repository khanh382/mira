export class CreateUserDto {
  username: string;
  email: string;
  password: string;
  level: 'colleague' | 'client';
}
