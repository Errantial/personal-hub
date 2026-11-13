import { describe, expect, it } from 'vitest';
import { topicLabelState } from '../src/ai/topic-labels.js';

describe('topic AI label eligibility', () => {
  it('unions topic, class and retained history labels', () => {
    expect(
      topicLabelState(
        { sensitivity: 'unlabeled', academicLabels: ['restricted'] },
        'personal',
      ),
    ).toEqual({
      complete: true,
      labels: ['personal', 'restricted'],
    });
    expect(
      topicLabelState(
        { sensitivity: 'personal', academicLabels: ['restricted'] },
        'unlabeled',
      ),
    ).toEqual({
      complete: true,
      labels: ['personal', 'restricted'],
    });
  });

  it('uses unlabeled only when every effective label is unlabeled', () => {
    expect(
      topicLabelState(
        { sensitivity: 'unlabeled', academicLabels: [] },
        'unlabeled',
      ),
    ).toEqual({ complete: true, labels: ['unlabeled'] });
  });

  it('fails closed for missing or malformed retained history', () => {
    expect(
      topicLabelState(
        { sensitivity: 'unlabeled', academicLabels: null },
        'unlabeled',
      ),
    ).toEqual({ complete: false });
    expect(
      topicLabelState(
        { sensitivity: 'unlabeled', academicLabels: ['unknown'] },
        'unlabeled',
      ),
    ).toEqual({ complete: false });
    expect(
      topicLabelState(
        { sensitivity: 'invalid', academicLabels: [] },
        'unlabeled',
      ),
    ).toEqual({ complete: false });
  });
});
