import { JobStatus } from '../types';
import { LIFECYCLE_STAGES, JOB_STATUSES } from '../utils/constants';

interface LifecycleTrackerProps {
  currentStatus: JobStatus;
  onAdvance?: (newStatus: JobStatus) => void;
  disabled?: boolean;
}

export default function LifecycleTracker({ currentStatus, onAdvance, disabled }: LifecycleTrackerProps) {
  const stages = LIFECYCLE_STAGES;
  const currentIndex = stages.indexOf(currentStatus);

  return (
    <div className="w-full">
      {/* Progress bar */}
      <div className="relative flex items-center">
        {stages.map((stage, index) => {
          const statusInfo = JOB_STATUSES.find(s => s.value === stage);
          const isCompleted = index < currentIndex;
          const isCurrent = index === currentIndex;
          const isNext = index === currentIndex + 1;

          return (
            <div key={stage} className="flex-1 flex flex-col items-center relative">
              {/* Connecting line */}
              {index > 0 && (
                <div
                  className={`absolute left-0 top-4 -translate-y-1/2 w-full h-0.5 -z-10 ${
                    index <= currentIndex ? 'bg-brand-500' : 'bg-gray-200'
                  }`}
                  style={{ transform: 'translateX(-50%)' }}
                />
              )}

              {/* Circle */}
              <button
                onClick={() => isNext && !disabled && onAdvance?.(stage)}
                disabled={!isNext || disabled}
                className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold border-2 transition-all ${
                  isCompleted
                    ? 'bg-brand-500 border-brand-500 text-white'
                    : isCurrent
                    ? 'bg-white border-brand-500 text-brand-600 ring-4 ring-brand-100'
                    : isNext && !disabled
                    ? 'bg-white border-gray-300 text-gray-400 hover:border-brand-400 hover:text-brand-500 cursor-pointer'
                    : 'bg-white border-gray-200 text-gray-300 cursor-default'
                }`}
                title={statusInfo?.label || stage}
              >
                {isCompleted ? '✓' : index + 1}
              </button>

              {/* Label */}
              <p className={`mt-1.5 text-center leading-tight text-xs max-w-[60px] ${
                isCurrent ? 'font-bold text-brand-700' :
                isCompleted ? 'text-gray-500' : 'text-gray-300'
              }`}>
                {statusInfo?.label?.replace(' ', '\n') || stage}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
