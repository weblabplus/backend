import { LabResult } from '@medilab/core';
import { ILabParser, ParseResult, ParseError, ParseOptions, ParseMetadata } from './types';
import { CsvLabParser } from './csv.parser';
import { JsonLabParser } from './json.parser';
import { Hl7LabParser } from './hl7.parser';

/**
 * Parser Factory - Επιλέγει τον κατάλληλο parser με βάση το format
 */
export class LabParserFactory {
  private parsers: Map<string, ILabParser> = new Map();

  constructor() {
    this.registerParser(new CsvLabParser());
    this.registerParser(new JsonLabParser());
    this.registerParser(new Hl7LabParser());
  }

  registerParser(parser: ILabParser): void {
    for (const format of parser.getSupportedFormats()) {
      this.parsers.set(format.toLowerCase(), parser);
    }
  }

  getParser(format: string): ILabParser | undefined {
    return this.parsers.get(format.toLowerCase());
  }

  getSupportedFormats(): string[] {
    return Array.from(this.parsers.keys());
  }

  async parse(
    data: string | Buffer,
    format: string,
    options?: ParseOptions
  ): Promise<ParseResult> {
    const parser = this.getParser(format);
    if (!parser) {
      return {
        success: false,
        results: [],
        errors: [{
          message: `Μη υποστηριζόμενο format: ${format}. Υποστηρίζονται: ${this.getSupportedFormats().join(', ')}`,
          severity: 'error',
        }],
        metadata: {
          format,
          totalLines: 0,
          parsedLines: 0,
          errorLines: 1,
          parseDuration: 0,
        },
      };
    }

    const strData = typeof data === 'string' ? data : data.toString('utf-8');
    return parser.parse(strData, options);
  }
}

// Singleton instance
export const labParserFactory = new LabParserFactory();
