export class UpdateUserByOwnerDto {
  level?: 'colleague' | 'client';
  status?: 'active' | 'block';
  password?: string;
}
