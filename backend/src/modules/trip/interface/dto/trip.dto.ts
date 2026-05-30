import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class AnchorDto {
  @IsString()
  eventId!: string;

  @IsString()
  ticketTier!: string;

  @IsInt()
  @Min(1)
  @Max(20)
  quantity!: number;
}

export class CreateTripDto {
  @ValidateNested()
  @Type(() => AnchorDto)
  anchor!: AnchorDto;
}

export class CheckoutDto {
  @IsOptional()
  @IsString()
  quoteToken?: string;
}

export class ConfirmTripDto {
  @IsString()
  paymentIntentId!: string;
}

export class CancelTripDto {
  @IsOptional()
  @IsString()
  reason?: string;
}
